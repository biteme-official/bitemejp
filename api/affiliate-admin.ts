/**
 * 어필리에이트 어드민 API
 *
 *  GET  /api/affiliate-admin              파트너 목록(이달·누적 성과, 이달 클릭) + 최근 전환 + 캠페인(전용 코드·성과)
 *  POST action=create_campaign            캠페인 생성 → (할인 있으면) 파트너별 Shopify 전용 코드 → LINE 통지 (Phase 3)
 *  POST action=end_campaign { campaignId } 캠페인 종료 + 전용 코드 비활성 (Phase 3)
 *  POST action=delete_campaign { campaignId } 적용 주문 0건인 캠페인 삭제(잘못 만든 것 정리)
 *  POST /api/affiliate-admin  action=add_partner
 *       { code, name, instagram?, email?, discountCode? }
 *       Phase 2 셀프 가입 전까지 하영이 어드민에서 파트너를 앉힌다.
 *       discountCode 를 주면 기존 Collabs 할인코드를 「Collabs 이행 코드」 캠페인에 묶어
 *       그 코드가 붙은 주문이 바로 장부에 잡히게 한다.
 *
 * 인증: Authorization: Bearer ADMIN_SECRET (다른 어드민 API 와 동일)
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  BASE_RATE,
  LEGACY_CAMPAIGN_NAME,
  MANUAL_LINE_ID_PREFIX,
  getSupabase,
  isAffiliateEnabled,
  type AffPartner,
  ADMIN_ORDER_FIELDS,
  fetchAllRows,
  reevaluateOrder,
  toOrderForAttribution,
  type AdminOrderNode,
} from './_affiliate.js';
import { createCampaign, deleteCampaign, disablePartnerCodes, endCampaign, parseCampaignInput } from './_affiliate-campaign.js';
import { SHOPIFY_API_VERSION } from './_shopify-api-version.js';

const CODE_RE = /^[A-Z0-9]{4,12}$/;

function authorized(req: VercelRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${secret}`;
}

/** JST 기준 이달 1일 00:00 (UTC ISO) */
function monthStartJst(): string {
  const now = new Date(Date.now() + 9 * 3600_000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return new Date(Date.UTC(y, m, 1) - 9 * 3600_000).toISOString();
}

interface ConversionRow {
  id: number;
  order_id: string;
  order_name: string | null;
  partner_id: number;
  attribution: string;
  eligible_amount: number;
  rate: number;
  rate_source: string;
  commission: number;
  status: string;
  ordered_at: string;
  confirm_at: string;
}

type Stats = { orders: number; sales: number; pending: number; confirmed: number; self: number };
const emptyStats = (): Stats => ({ orders: 0, sales: 0, pending: 0, confirmed: 0, self: 0 });

async function handleGet(res: VercelResponse) {
  const sb = getSupabase();
  const since = monthStartJst();

  type Row = { partner_id: number; status: string; commission: number; eligible_amount: number; campaign_id: number | null; ordered_at: string };
  const [partnersQ, recentQ, campaignsQ, codesQ, allRows, clickRows] = await Promise.all([
    sb.from('aff_partners').select('*').order('joined_at', { ascending: false }),
    sb.from('aff_conversions').select('*').order('ordered_at', { ascending: false }).limit(50),
    sb.from('aff_campaigns').select('*').order('starts_at', { ascending: false }),
    sb.from('aff_campaign_codes').select('partner_id, shopify_code, status, campaign_id'),
    // 누적·이달·캠페인 성과를 한 번에 — 1,000행 넘어가도 끝까지 읽어 서버에서 접는다
    fetchAllRows<Row>((from, to) => sb.from('aff_conversions').select('partner_id, status, commission, eligible_amount, campaign_id, ordered_at').order('id').range(from, to)),
    fetchAllRows<{ partner_id: number }>((from, to) => sb.from('aff_clicks').select('partner_id').eq('is_bot', false).gte('ts', since).order('id').range(from, to)),
  ]);
  const firstError = [partnersQ, recentQ, campaignsQ, codesQ].find((q) => q.error)?.error;
  if (firstError) return res.status(500).json({ error: firstError.message });

  const month = new Map<number, Stats>();
  const total = new Map<number, Stats>();
  const byCampaign = new Map<number, { orders: number; sales: number; commission: number }>();
  // 회원 한정이 거른 것 — 비회원 주문은 파트너별 성과에 넣지 않고 따로 센다
  const nonmember = { orders: 0, sales: 0 };
  const add = (m: Map<number, Stats>, r: Row) => {
    const s = m.get(r.partner_id) ?? emptyStats();
    s.orders += 1;
    s.sales += r.eligible_amount;
    if (r.status === 'pending') s.pending += r.commission;
    if (r.status === 'confirmed') s.confirmed += r.commission;
    if (r.status === 'self') s.self += 1;
    m.set(r.partner_id, s);
  };
  for (const r of allRows) {
    const inMonth = r.ordered_at >= since;
    if (r.status === 'nonmember') {
      if (inMonth) { nonmember.orders += 1; nonmember.sales += r.eligible_amount; }
      continue;
    }
    add(total, r);
    if (inMonth) add(month, r);
    if (r.campaign_id != null && (r.status === 'pending' || r.status === 'confirmed')) {
      const c = byCampaign.get(r.campaign_id) ?? { orders: 0, sales: 0, commission: 0 };
      c.orders += 1; c.sales += r.eligible_amount; c.commission += r.commission;
      byCampaign.set(r.campaign_id, c);
    }
  }

  const clicks = new Map<number, number>();
  for (const c of clickRows) clicks.set(c.partner_id, (clicks.get(c.partner_id) ?? 0) + 1);

  const codesByPartner = new Map<number, string[]>();
  const codesByCampaign = new Map<number, Array<{ partnerId: number; code: string; status: string }>>();
  for (const c of (codesQ.data ?? []) as Array<{ partner_id: number; shopify_code: string; status: string; campaign_id: number }>) {
    codesByCampaign.set(c.campaign_id, [...(codesByCampaign.get(c.campaign_id) ?? []), { partnerId: c.partner_id, code: c.shopify_code, status: c.status }]);
    if (c.status !== 'active') continue;
    codesByPartner.set(c.partner_id, [...(codesByPartner.get(c.partner_id) ?? []), c.shopify_code]);
  }

  const partners = ((partnersQ.data ?? []) as AffPartner[]).map((p) => ({
    ...p,
    manual: p.line_user_id.startsWith(MANUAL_LINE_ID_PREFIX),
    codes: codesByPartner.get(p.id) ?? [],
    month: month.get(p.id) ?? emptyStats(),
    total: total.get(p.id) ?? emptyStats(),
    monthClicks: clicks.get(p.id) ?? 0,
  }));

  const codeById = new Map(partners.map((p) => [p.id, p.code]));
  const recent = ((recentQ.data ?? []) as ConversionRow[]).map((c) => ({ ...c, partner_code: codeById.get(c.partner_id) ?? '?' }));
  const campaigns = ((campaignsQ.data ?? []) as Array<{ id: number } & Record<string, unknown>>).map((c) => ({
    ...c,
    codes: (codesByCampaign.get(c.id) ?? []).map((k) => ({ ...k, partnerCode: codeById.get(k.partnerId) ?? '?' })),
    result: byCampaign.get(c.id) ?? { orders: 0, sales: 0, commission: 0 },
  }));

  return res.status(200).json({
    ok: true,
    enabled: isAffiliateEnabled(),
    baseRate: BASE_RATE,
    monthStart: since,
    nonmember,
    partners,
    recent,
    campaigns,
  });
}

async function handleCreateCampaign(body: Record<string, unknown>, res: VercelResponse) {
  const input = parseCampaignInput(body);
  if (typeof input === 'string') return res.status(400).json({ error: input });
  const r = await createCampaign(getSupabase(), input);
  if (typeof r === 'string') return res.status(400).json({ error: r });
  return res.status(201).json({ ok: true, ...r });
}

async function handleEndCampaign(body: Record<string, unknown>, res: VercelResponse) {
  const id = Number(body.campaignId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'campaignId 필요' });
  const r = await endCampaign(getSupabase(), id);
  if (typeof r === 'string') return res.status(400).json({ error: r });
  return res.status(200).json({ ok: true, ...r });
}

async function handleDeleteCampaign(body: Record<string, unknown>, res: VercelResponse) {
  const id = Number(body.campaignId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'campaignId 필요' });
  const r = await deleteCampaign(getSupabase(), id);
  if (typeof r === 'string') return res.status(409).json({ error: r });
  return res.status(200).json({ ok: true, ...r });
}

async function handleAddPartner(body: Record<string, unknown>, res: VercelResponse) {
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  const instagram = String(body.instagram ?? '').trim().replace(/^@/, '') || null;
  const email = String(body.email ?? '').trim().toLowerCase() || null;
  const discountCode = String(body.discountCode ?? '').trim().toUpperCase() || null;

  if (!CODE_RE.test(code)) return res.status(400).json({ error: '코드는 대문자·숫자 4~12자' });
  if (!name) return res.status(400).json({ error: '이름은 필수' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: '이메일 형식이 아님' });

  const sb = getSupabase();
  const now = new Date().toISOString();

  const { data: partner, error: pErr } = await sb
    .from('aff_partners')
    .insert({
      code,
      line_user_id: `${MANUAL_LINE_ID_PREFIX}${code}`,
      name,
      instagram,
      email,
      status: 'active',
      terms_version: 'manual',     // 어드민 수동 등록 — 약관 동의는 Phase 2 LINE 가입 시 갈아탐
      agreed_at: now,
      adult_confirmed_at: now,
      memo: '어드민 수동 등록',
    })
    .select('*')
    .single();
  if (pErr) {
    const dup = pErr.code === '23505';
    return res.status(dup ? 409 : 500).json({ error: dup ? '이미 있는 코드' : pErr.message });
  }

  let legacyCode: string | null = null;
  if (discountCode) {
    // 「Collabs 이행 코드」 캠페인 — 없으면 만든다. 기본 요율과 같은 10%, 종료 없음
    let { data: camp } = await sb.from('aff_campaigns').select('id, target_ids').eq('name', LEGACY_CAMPAIGN_NAME).maybeSingle();
    if (!camp) {
      const created = await sb
        .from('aff_campaigns')
        .insert({
          name: LEGACY_CAMPAIGN_NAME,
          starts_at: '2026-01-01T00:00:00Z',
          ends_at: '2099-12-31T00:00:00Z',
          commission_rate: BASE_RATE,
          discount_percent: null,
          scope: 'partners',
          target_ids: [],
          active: true,
          created_by: 'system',
        })
        .select('id, target_ids')
        .single();
      if (created.error) return res.status(500).json({ error: created.error.message, partner });
      camp = created.data;
    }
    const ids = new Set<string>((camp.target_ids as string[]) ?? []);
    ids.add(String(partner.id));
    await sb.from('aff_campaigns').update({ target_ids: [...ids] }).eq('id', camp.id);

    const { error: cErr } = await sb.from('aff_campaign_codes').insert({
      campaign_id: camp.id,
      partner_id: partner.id,
      shopify_code: discountCode,
      shopify_discount_gid: 'legacy',   // Collabs 가 만든 코드 — 우리가 발급하지 않았다
      status: 'active',
    });
    if (cErr) {
      const dup = cErr.code === '23505';
      return res.status(dup ? 409 : 500).json({ error: dup ? '이미 다른 파트너에 묶인 할인코드' : cErr.message, partner });
    }
    legacyCode = discountCode;
  }

  return res.status(201).json({ ok: true, partner, legacyCode });
}

/**
 * 파트너 상태 변경 — active(활동) / suspended(정지, 第12条 2항) / withdrawn(탈퇴).
 * 정지·탈퇴하면 살아 있는 터치를 지워 더 이상 귀속되지 않게 한다(第12条 4항).
 */
async function handleSetStatus(body: Record<string, unknown>, res: VercelResponse) {
  const sb = getSupabase();
  const id = Number(body.partnerId);
  const status = String(body.status ?? '');
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'partnerId 필요' });
  if (!['active', 'suspended', 'withdrawn'].includes(status)) return res.status(400).json({ error: 'status 는 active|suspended|withdrawn' });
  const patch: Record<string, unknown> = { status };
  if (status === 'withdrawn') patch.withdrawn_at = new Date().toISOString();
  if (typeof body.memo === 'string') patch.memo = body.memo.slice(0, 500);
  const { data, error } = await sb.from('aff_partners').update(patch).eq('id', id).select('*').maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: '파트너 없음' });
  if (status !== 'active') {
    await sb.from('aff_touches').delete().eq('partner_id', id);
    // 第12条 — 정지·탈퇴 즉시 링크·코드 무효. 다시 활동으로 돌려도 코드는 자동 복구하지 않는다(캠페인을 새로)
    await disablePartnerCodes(sb, id);
  }
  return res.status(200).json({ ok: true, partner: data });
}

/** 파트너 삭제 — 장부(aff_conversions)에 한 건이라도 있으면 거절. 테스트 파트너 정리용 */
async function handleDeletePartner(body: Record<string, unknown>, res: VercelResponse) {
  const sb = getSupabase();
  const id = Number(body.partnerId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'partnerId 필요' });
  const { count, error: cErr } = await sb.from('aff_conversions').select('id', { count: 'exact', head: true }).eq('partner_id', id);
  if (cErr) return res.status(500).json({ error: cErr.message });
  if ((count ?? 0) > 0) return res.status(409).json({ error: `장부에 ${count}건이 있어 삭제 불가 — 정지(suspended)로 처리할 것` });
  // 코드·클릭·터치는 FK cascade 로 함께 지워진다 — Shopify 쪽 전용 코드는 cascade 가 못 끄니 먼저 끈다
  await disablePartnerCodes(sb, id);
  const { error } = await sb.from('aff_partners').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, deleted: id });
}

/** 주문 재판정 — 주문번호(#3728 또는 3728)로 Shopify 에서 다시 읽어 장부를 다시 쓴다 */
async function handleReevaluate(body: Record<string, unknown>, res: VercelResponse) {
  const name = String(body.orderName ?? '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(name)) return res.status(400).json({ error: 'orderName 필요 (#3728)' });
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'REPORT_SHOPIFY 미설정' });
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const tokRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const token = (await tokRes.json()).access_token as string | undefined;
  if (!token) return res.status(500).json({ error: 'Admin 토큰 실패' });
  const q = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ADMIN_ORDER_FIELDS} lineIdMeta: customer { lineId: metafield(namespace: "custom", key: "line_id") { value } } } } }`, variables: { q: `name:#${name}` } }),
  }).then((r) => r.json());
  const node = q?.data?.orders?.nodes?.[0] as (AdminOrderNode & { lineIdMeta?: { lineId?: { value: string } | null } | null }) | undefined;
  if (!node) return res.status(404).json({ error: `주문 #${name} 없음 (60일 이내만 조회 가능)` });
  const lineUserId = node.lineIdMeta?.lineId?.value ?? null;
  const r = await reevaluateOrder(toOrderForAttribution(node), { lineUserId });
  return res.status(r.outcome === 'error' ? 500 : 200).json({ ok: r.outcome !== 'error', ...r });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') return await handleGet(res);
    if (req.method === 'POST') {
      const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;
      if (body.action === 'add_partner') return await handleAddPartner(body, res);
      if (body.action === 'set_status') return await handleSetStatus(body, res);
      if (body.action === 'delete_partner') return await handleDeletePartner(body, res);
      if (body.action === 'reevaluate_order') return await handleReevaluate(body, res);
      if (body.action === 'create_campaign') return await handleCreateCampaign(body, res);
      if (body.action === 'end_campaign') return await handleEndCampaign(body, res);
      if (body.action === 'delete_campaign') return await handleDeleteCampaign(body, res);
      return res.status(400).json({ error: `unknown action: ${String(body.action)}` });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[affiliate-admin]', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
}
