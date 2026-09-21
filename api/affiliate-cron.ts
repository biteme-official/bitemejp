/**
 * /api/affiliate-cron — 어필리에이트 장부 일일 크론 (#178 Phase 1, 설계 §5·§8 07·§12)
 *
 * 하루 한 번 두 가지를 한다.
 *  1. 확정 — confirm_at 이 지난 pending 건을 Shopify 에서 다시 읽어(취소·환불 반영) confirmed / reversed / 재계산.
 *     웹훅이 놓친 환불도 여기서 잡힌다 — 웹훅은 «몇 초 안에 반영»하는 보강이지 정확성의 전제가 아니다.
 *  2. 재대사 — 지난 이틀치 주문을 Admin 으로 훑어 장부에 없는 주문을 다시 판정한다(웹훅 유실 방어).
 *     이미 있는 주문은 order_id 유니크라 두 번 쌓이지 않는다.
 *
 * 인증: Vercel 크론의 `Authorization: Bearer <CRON_SECRET>`. 수동 실행도 같은 헤더로.
 * 절대 throw 로 끝나지 않는다 — 한 건의 실패가 나머지를 막지 않게 건별로 삼키고 요약을 돌려준다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SHOPIFY_API_VERSION } from './_shopify-api-version.js';
import {
  ADMIN_ORDER_FIELDS as ORDER_FIELDS,
  applyOrderAmount,
  getSupabase,
  isAffiliateEnabled,
  recordConversionFromOrder,
  toOrderForAttribution,
  type AdminOrderNode,
  type AffConversionRow,
} from './_affiliate.js';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
/** 재대사가 훑는 범위 — 어제 0시(JST) 부터. 웹훅 유실은 길어야 몇 분이라 이틀이면 충분하다 */
const RECONCILE_DAYS = 2;
const CONFIRM_BATCH = 200;

async function getAdminToken(): Promise<string> {
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing REPORT_SHOPIFY credentials');
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Admin token ${res.status}`);
  return (await res.json()).access_token;
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Admin GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

function numericId(gid: string): number {
  return Number(String(gid).split('/').pop());
}

// ── 1. 확정 ──────────────────────────────────────────────────────────────────

async function confirmDue(token: string) {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from('aff_conversions')
    .select('*')
    .eq('status', 'pending')
    .lte('confirm_at', now)
    .order('confirm_at', { ascending: true })
    .limit(CONFIRM_BATCH);
  if (error) throw new Error(`pending 조회 실패: ${error.message}`);

  const summary = { due: (data ?? []).length, confirmed: 0, reversed: 0, recalculated: 0, errors: 0 };
  for (const row of (data ?? []) as AffConversionRow[]) {
    try {
      const d = await adminGraphQL(token, `query($id: ID!) { order(id: $id) { cancelledAt currentSubtotalPriceSet { shopMoney { amount } } } }`,
        { id: `gid://shopify/Order/${row.order_id}` });
      const order = d?.order as { cancelledAt: string | null; currentSubtotalPriceSet: { shopMoney: { amount: string } } } | null;
      if (!order) {
        // read_all_orders 가 없어 60일 넘은 주문은 안 보인다 — 확정 대기 30일 안이면 생길 수 없는 경우. 남겨두고 다음 날 다시
        console.error(`[Affiliate] 🔴 확정 재확인 실패 — 주문 조회 안 됨 ${row.order_name ?? row.order_id}`);
        summary.errors += 1;
        continue;
      }
      const r = await applyOrderAmount(sb, row, Number(order.currentSubtotalPriceSet.shopMoney.amount), !!order.cancelledAt, 'confirm-check');
      if (r === 'reversed') { summary.reversed += 1; continue; }
      if (r === 'recalculated') summary.recalculated += 1;
      const { error: upErr } = await sb
        .from('aff_conversions')
        .update({ status: 'confirmed', confirmed_at: now, updated_at: now })
        .eq('id', row.id)
        .eq('status', 'pending');
      if (upErr) throw new Error(upErr.message);
      summary.confirmed += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`[Affiliate] 🔴 확정 처리 실패 ${row.order_name ?? row.order_id}:`, err instanceof Error ? err.message : err);
    }
  }
  return summary;
}

// ── 2. 재대사 ────────────────────────────────────────────────────────────────

async function reconcileRecent(token: string) {
  const sb = getSupabase();
  const sinceMs = Date.now() - RECONCILE_DAYS * 86_400_000;
  const since = new Date(sinceMs).toISOString();

  const orders: AdminOrderNode[] = [];
  let cursor: string | null = null;
  do {
    const d = await adminGraphQL(token, `query($q: String!, $after: String) {
      orders(first: 100, query: $q, after: $after, sortKey: CREATED_AT) {
        nodes { ${ORDER_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`, { q: `created_at:>='${since}'`, after: cursor });
    orders.push(...(d.orders.nodes as AdminOrderNode[]));
    cursor = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (cursor);

  const ids = orders.map((o) => o.legacyResourceId);
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('aff_conversions').select('order_id').in('order_id', ids.slice(i, i + 200));
    if (error) throw new Error(`장부 대조 조회 실패: ${error.message}`);
    for (const r of (data ?? []) as Array<{ order_id: string }>) known.add(r.order_id);
  }

  const summary = { scanned: orders.length, alreadyInLedger: known.size, inserted: 0, nonmember: 0, unattributed: 0, errors: 0 };
  for (const o of orders) {
    if (known.has(o.legacyResourceId) || o.cancelledAt) continue;
    const r = await recordConversionFromOrder(toOrderForAttribution(o));
    if (r.outcome === 'inserted') { summary.inserted += 1; console.log(`[Affiliate] 재대사로 적재 ${o.name}`); }
    else if (r.outcome === 'nonmember') summary.nonmember += 1;
    else if (r.outcome === 'unattributed' || r.outcome === 'duplicate') summary.unattributed += 1;
    else if (r.outcome === 'error') { summary.errors += 1; console.error(`[Affiliate] 🔴 재대사 실패 ${o.name}:`, r.detail); }
  }
  return summary;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel 크론은 CRON_SECRET. 수동 실행(게이트 확인)은 어드민 비밀도 허용 — 둘 다 없으면 잠긴다
  const auth = req.headers.authorization;
  const okCron = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const okAdmin = !!process.env.ADMIN_SECRET && auth === `Bearer ${process.env.ADMIN_SECRET}`;
  if (!okCron && !okAdmin) return res.status(401).json({ error: 'Unauthorized' });
  if (!isAffiliateEnabled()) return res.status(200).json({ ok: true, skipped: 'disabled' });

  const startedAt = Date.now();
  const result: Record<string, unknown> = { ok: true };
  let token: string;
  try {
    token = await getAdminToken();
  } catch (err) {
    console.error('[Affiliate] 🔴 크론 Admin 토큰 실패:', err);
    return res.status(200).json({ ok: false, error: 'admin token' });
  }

  try { result.confirm = await confirmDue(token); }
  catch (err) { result.confirm = { error: err instanceof Error ? err.message : String(err) }; console.error('[Affiliate] 🔴 확정 단계 실패:', err); }

  try { result.reconcile = await reconcileRecent(token); }
  catch (err) { result.reconcile = { error: err instanceof Error ? err.message : String(err) }; console.error('[Affiliate] 🔴 재대사 단계 실패:', err); }

  result.ms = Date.now() - startedAt;
  console.log('[Affiliate] 크론 완료', JSON.stringify(result));
  return res.status(200).json(result);
}
