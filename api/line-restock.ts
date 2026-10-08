/**
 * /api/line-restock — 품절 상품 재입고 LINE 알림
 *
 * 한 파일에 두 갈래가 있다.
 *   - POST  신청. 상품 상세에서 품절 옵션을 보던 LINE 로그인 고객이 「再入荷をLINEで受け取る」를 누르면 온다.
 *   - GET   발송. 크론이 매시간 돌며 신청된 옵션이 다시 팔리는지 보고, 팔리면 신청자에게 LINE 을 보낸다.
 *
 * 저장소는 따로 만들지 않고 Supabase `events` 를 그대로 쓴다(장바구니 스냅샷과 같은 방식).
 *   - 신청   event_type = `line_restock_sub` · session_id = `line:<userId>`
 *   - 발송   `line_send` (journey = `restock`, ref = 신청 행을 가리키는 키)
 * 신청 한 건에 알림은 한 통이다. 다시 품절됐다가 또 받고 싶으면 다시 신청하면 된다.
 *
 * 🔴 신청자의 LINE userId 는 클라이언트가 보낸 값을 믿지 않는다. 서명된 `lineSessionToken` 에서만
 *    꺼낸다 — 안 그러면 남의 userId 로 신청해 그 사람에게 메시지를 보내게 만들 수 있다.
 *
 * 마케팅 빈도 제한(하루 1통)은 걸지 않는다(`kind: transactional`). 고객이 직접 달라고 한 알림이라,
 * 그날 다른 저니가 먼저 나갔다고 재입고 소식이 사라지면 신청한 의미가 없다.
 * 대신 조용한 시간(JST 21~09시)은 지킨다 — 버리지 않고 다음 실행으로 미룬다.
 *
 * ⚠️ 사람에게 메시지가 나가는 크론이라 `LINE_RESTOCK_ENABLED=1` 일 때만 실제로 보낸다.
 *    `?dryRun=1` 은 지금 켜면 누구에게 무엇이 나가는지만 돌려준다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  SEND_EVENT,
  adminGraphQL,
  fetchQuota,
  getAdminToken,
  inQuietHours,
  lineToken,
  recordSends,
  supabase,
} from './line-campaign.js';

export const RESTOCK_SUB_EVENT = 'line_restock_sub';
const JOURNEY = 'restock';
const UTM = 'line_restock';

/** 이보다 오래된 신청은 보지 않는다. 신청 행을 끝없이 다시 읽지 않기 위한 상한. */
const SUB_TTL_DAYS = 180;
/** 한 번 실행에 보낼 수 있는 최대 인원 — 폭주 방지. 남은 사람은 다음 실행에서 나간다. */
const MAX_PER_RUN = 200;

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** api/line-callback.ts 의 signSessionToken 과 한 쌍 (api/line-cart.ts 와 같은 구현) */
function verifySessionToken(token: unknown, secret: string): { lineUserId: string } | null {
  if (typeof token !== 'string') return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.e !== 'number' || Date.now() > payload.e) return null;
    if (typeof payload?.u !== 'string' || !payload.u) return null;
    return { lineUserId: payload.u };
  } catch {
    return null;
  }
}

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

/** api/line-journey.ts 와 같은 규칙 — `x-vercel-cron` 헤더는 누구나 붙일 수 있어 인증으로 쓰지 않는다 */
function authorized(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (process.env.ADMIN_SECRET && auth === `Bearer ${process.env.ADMIN_SECRET}`) return true;
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  return false;
}

// ─── Shopify ─────────────────────────────────────────────────────────────────

interface VariantState {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  /** 지금 팔 수 있는가 — 상품이 판매 중(ACTIVE)이고 옵션이 구매 가능 */
  available: boolean;
  /** 판매 종료 태그가 붙은 옵션 — 다시 들어오지 않으니 신청을 받지 않는다 (#223) */
  discontinued: boolean;
}

/**
 * 판매 종료 태그 (#223). src/lib/productStock.ts 의 isVariantDiscontinued 와 같은 규칙 — 같이 고칠 것.
 *   `販売終了` 상품 전체 · `販売終了:<옵션명>` 그 옵션만 · `discontinued`·`단종` 도 같은 뜻
 */
const DISCONTINUED_TAGS = ['販売終了', 'discontinued', '단종'];
const normTitle = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function isVariantDiscontinued(tags: string[], variantTitle: string): boolean {
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    for (const key of DISCONTINUED_TAGS.map((k) => k.toLowerCase())) {
      if (t === key) return true;
      if (t.startsWith(`${key}:`) && normTitle(t.slice(key.length + 1)) === normTitle(variantTitle)) return true;
    }
  }
  return false;
}

interface VariantNodesResponse {
  data?: {
    nodes: ({
      id: string;
      title: string;
      availableForSale: boolean;
      product: { id: string; title: string; status: string; tags: string[] };
    } | null)[];
  };
  errors?: unknown;
}

/** 옵션 id 목록의 현재 상태. 없는(삭제된) 옵션은 결과에서 빠진다. */
async function fetchVariantStates(token: string, variantIds: string[]): Promise<Map<string, VariantState>> {
  const out = new Map<string, VariantState>();
  // nodes(ids:) 는 한 번에 250개까지 받는다
  for (let i = 0; i < variantIds.length; i += 250) {
    const ids = variantIds.slice(i, i + 250);
    const res = await adminGraphQL<VariantNodesResponse>(
      token,
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            availableForSale
            product { id title status tags }
          }
        }
      }`,
      { ids },
    );
    // 🔴 조회가 실패했는데 빈 결과로 넘기면 「아무것도 재입고 안 됨」으로 읽힌다. 실패는 실패로 던진다.
    if (!res?.data?.nodes) throw new Error(`옵션 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 200)}`);
    for (const n of res.data.nodes) {
      if (!n?.id || !n.product) continue;
      out.set(n.id, {
        variantId: n.id,
        productId: n.product.id,
        productTitle: n.product.title,
        // 옵션이 하나뿐인 상품은 Shopify 가 「Default Title」을 준다 — 문안에 쓰지 않는다
        variantTitle: n.title === 'Default Title' ? '' : n.title,
        available: n.product.status === 'ACTIVE' && n.availableForSale,
        discontinued: isVariantDiscontinued(n.product.tags ?? [], n.title),
      });
    }
  }
  return out;
}

// ─── LINE ────────────────────────────────────────────────────────────────────

/**
 * 공식계정 친구인가. push 는 친구에게만 닿으므로 신청 시점에 알려 준다.
 * 확인이 안 되면(토큰 없음·LINE 장애) null — 신청은 받고 안내만 생략한다.
 */
async function isFriend(userId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${lineToken()}` },
    });
    if (res.ok) return true;
    // 404 = 친구가 아니거나 차단
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

async function pushLine(userId: string, text: string): Promise<'sent' | 'not-friend' | 'failed'> {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken()}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
  });
  if (res.ok) return 'sent';
  // 403 = 친구가 아니거나 차단. 우리가 고칠 수 있는 게 아니다.
  if (res.status === 403) return 'not-friend';
  console.error(`[LINE Restock] 🔴 push 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return 'failed';
}

// ─── 신청 기록 ────────────────────────────────────────────────────────────────

interface Subscription {
  lineUserId: string;
  productId: string;
  variantId: string;
  createdAt: string;
  /** 발송 기록의 ref — 이 신청을 가리키는 키. 같은 사람·옵션이라도 다시 신청하면 새 키가 된다. */
  ref: string;
}

function subRef(variantId: string, createdAt: string): string {
  return `${variantId.split('/').pop()}@${createdAt}`;
}

type Db = NonNullable<ReturnType<typeof supabase>>;

/**
 * PostgREST 는 한 번에 1,000행까지만 준다 — 조용히 잘리지 않게 끝까지 읽는다.
 * 정렬은 created_at 으로 고정한다(페이지 사이에 행이 밀리지 않도록).
 */
async function readAll<T>(db: Db, eventType: string, columns: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await db
      .from('events')
      .select(columns)
      .eq('event_type', eventType)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${eventType} 조회 실패: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** 아직 알림이 나가지 않은 신청 */
async function pendingSubscriptions(db: Db, now: number): Promise<Subscription[]> {
  const since = new Date(now - SUB_TTL_DAYS * 86_400_000).toISOString();
  const [subs, sends] = await Promise.all([
    readAll<{ session_id: string; created_at: string; properties: { productId?: string; variantId?: string } | null }>(
      db, RESTOCK_SUB_EVENT, 'session_id, created_at, properties', since,
    ),
    readAll<{ properties: { journey?: string; ref?: string } | null }>(db, SEND_EVENT, 'properties', since),
  ]);

  const done = new Set<string>();
  for (const s of sends) {
    if (s.properties?.journey === JOURNEY && s.properties.ref) done.add(s.properties.ref);
  }

  // 같은 사람이 같은 옵션을 여러 번 눌렀으면 한 건으로 친다 — 가장 최근 신청만 남긴다
  const latest = new Map<string, Subscription>();
  for (const row of subs) {
    const { productId, variantId } = row.properties ?? {};
    if (!row.session_id.startsWith('line:') || !productId || !variantId) continue;
    const lineUserId = row.session_id.slice(5);
    latest.set(`${lineUserId}|${variantId}`, {
      lineUserId,
      productId,
      variantId,
      createdAt: row.created_at,
      ref: subRef(variantId, row.created_at),
    });
  }
  return [...latest.values()].filter((s) => !done.has(s.ref));
}

// ─── GET ?view=admin: 어드민 「재입고 알림」 탭 ─────────────────────────────────

export type RestockStatus = 'waiting' | 'ready' | 'sent' | 'not_friend' | 'gone' | 'discontinued';

export interface RestockAdminRow {
  createdAt: string;
  /** LINE 표시 이름. 친구가 아니면 알 수 없어 null */
  displayName: string | null;
  /** 끝 6자리만 — 화면에 userId 전체를 띄우지 않는다 */
  userTail: string;
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  /**
   * waiting    아직 품절
   * ready      다시 팔리는 중 — 다음 정각 30분 실행에서 나간다
   * sent       알림 보냄
   * not_friend 보냈지만 친구가 아니라 닿지 않음
   * gone       옵션이 삭제됨
   * discontinued 품절인 채로 판매 종료 태그가 붙음 — 알림이 나갈 일 없음 (#223)
   */
  status: RestockStatus;
  sentAt: string | null;
}

async function lineDisplayName(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${lineToken()}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { displayName?: string }).displayName ?? null;
  } catch {
    return null;
  }
}

async function adminList(req: VercelRequest, res: VercelResponse) {
  // 어드민 전용 — 크론 시크릿으로는 열지 않는다
  if (!process.env.ADMIN_SECRET || req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });

  const now = Date.now();
  const since = new Date(now - SUB_TTL_DAYS * 86_400_000).toISOString();
  const [subs, sends] = await Promise.all([
    readAll<{
      session_id: string;
      created_at: string;
      properties: { productId?: string; variantId?: string; productTitle?: string; variantTitle?: string } | null;
    }>(db, RESTOCK_SUB_EVENT, 'session_id, created_at, properties', since),
    readAll<{ created_at: string; properties: { journey?: string; ref?: string; delivery?: string } | null }>(
      db, SEND_EVENT, 'created_at, properties', since,
    ),
  ]);

  const sentByRef = new Map<string, { at: string; delivery: string }>();
  for (const s of sends) {
    if (s.properties?.journey === JOURNEY && s.properties.ref) {
      sentByRef.set(s.properties.ref, { at: s.created_at, delivery: s.properties.delivery ?? 'sent' });
    }
  }

  // 같은 사람·옵션을 여러 번 누른 건 한 줄 — 발송 쪽과 같은 규칙(가장 최근 신청)
  const latest = new Map<string, (typeof subs)[number]>();
  for (const row of subs) {
    const p = row.properties ?? {};
    if (!row.session_id.startsWith('line:') || !p.productId || !p.variantId) continue;
    latest.set(`${row.session_id}|${p.variantId}`, row);
  }
  const rows = [...latest.values()];

  // 아직 안 보낸 신청만 지금 재고를 본다
  const unsent = rows.filter((r) => !sentByRef.has(subRef(r.properties!.variantId!, r.created_at)));
  const states = unsent.length
    ? await fetchVariantStates(await getAdminToken(), [...new Set(unsent.map((r) => r.properties!.variantId!))])
    : new Map<string, VariantState>();

  // 이름은 사람마다 한 번만 묻는다(친구가 아니면 null)
  const userIds = [...new Set(rows.map((r) => r.session_id.slice(5)))].slice(0, 300);
  const names = new Map<string, string | null>();
  for (let i = 0; i < userIds.length; i += 10) {
    const chunk = userIds.slice(i, i + 10);
    const got = await Promise.all(chunk.map(lineDisplayName));
    chunk.forEach((u, k) => names.set(u, got[k]));
  }

  const out: RestockAdminRow[] = rows
    .map((r) => {
      const p = r.properties!;
      const userId = r.session_id.slice(5);
      const sent = sentByRef.get(subRef(p.variantId!, r.created_at));
      const state = states.get(p.variantId!);
      const status: RestockStatus = sent
        ? sent.delivery === 'not-friend' ? 'not_friend' : 'sent'
        : !state ? 'gone' : state.available ? 'ready' : state.discontinued ? 'discontinued' : 'waiting';
      return {
        createdAt: r.created_at,
        displayName: names.get(userId) ?? null,
        userTail: userId.slice(-6),
        productId: p.productId!,
        variantId: p.variantId!,
        productTitle: state?.productTitle ?? p.productTitle ?? '',
        variantTitle: state?.variantTitle ?? p.variantTitle ?? '',
        status,
        sentAt: sent?.at ?? null,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return res.status(200).json({
    rows: out,
    enabled: process.env.LINE_RESTOCK_ENABLED === '1',
    ttlDays: SUB_TTL_DAYS,
  });
}

// ─── 문안 ────────────────────────────────────────────────────────────────────

function productUrl(productId: string): string {
  const id = productId.split('/').pop();
  return `https://biteme.co.jp/product/${id}?utm_source=line&utm_medium=line&utm_campaign=${UTM}`;
}

/** 줄바꿈·제어문자를 지운다. 상품명에 섞여 들어오면 문안 줄이 어긋난다. */
function oneLine(v: string): string {
  return [...v].map((ch) => (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! === 0x7f ? ' ' : ch)).join('').trim();
}

export function buildRestockMessage(items: { productId: string; productTitle: string; variantTitle: string }[]): string {
  const label = (i: (typeof items)[number]) =>
    `「${oneLine(i.productTitle)}${i.variantTitle ? `（${oneLine(i.variantTitle)}）` : ''}」`;

  const lines = ['お待たせしました🐾', 'BITE ME JAPANです。', ''];
  if (items.length === 1) {
    lines.push(`ご登録いただいた${label(items[0])}が再入荷しました。`);
  } else {
    lines.push('ご登録いただいた商品が再入荷しました。');
    for (const i of items) lines.push(`・${label(i)}`);
  }
  lines.push('', '数に限りがございますので、', 'お早めにご確認ください。', '');
  // 상품이 여럿이어도 링크는 상품마다 하나씩 — 옵션은 같은 상품 페이지에서 고른다
  const products = [...new Map(items.map((i) => [i.productId, i])).values()];
  for (const p of products) {
    lines.push(products.length === 1 ? '▼ 商品を見る' : `▼ ${oneLine(p.productTitle)}`, productUrl(p.productId));
  }
  return lines.join('\n');
}

// ─── POST: 신청 ──────────────────────────────────────────────────────────────

async function subscribe(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).json({ error: 'LINE_CHANNEL_SECRET 미설정' });

  let payload: unknown = req.body ?? {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: 'bad_request' });
    }
  }
  const { lineSessionToken, productId, variantId } = (payload ?? {}) as Record<string, unknown>;

  const session = verifySessionToken(lineSessionToken, secret);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  if (typeof productId !== 'string' || !PRODUCT_GID.test(productId)) return res.status(400).json({ error: 'bad_request' });
  if (typeof variantId !== 'string' || !VARIANT_GID.test(variantId)) return res.status(400).json({ error: 'bad_request' });

  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });

  // 옵션이 진짜 그 상품의 것이고 지금 품절인지 확인한다. 지어낸 id 로 신청 행이 쌓이지 않게.
  const states = await fetchVariantStates(await getAdminToken(), [variantId]);
  const state = states.get(variantId);
  if (!state || state.productId !== productId) return res.status(404).json({ error: 'not_found' });
  if (state.available) return res.status(409).json({ error: 'in_stock' });
  if (state.discontinued) return res.status(409).json({ error: 'discontinued' });

  // 이미 신청해 두고 아직 알림을 못 받은 상태면 행을 또 쌓지 않는다
  const pending = await pendingSubscriptions(db, Date.now());
  const already = pending.some((s) => s.lineUserId === session.lineUserId && s.variantId === variantId);

  if (!already) {
    const { error } = await db.from('events').insert({
      event_type: RESTOCK_SUB_EVENT,
      session_id: `line:${session.lineUserId}`,
      properties: {
        productId,
        variantId,
        productTitle: state.productTitle,
        variantTitle: state.variantTitle,
      },
      page_path: `/product/${productId.split('/').pop()}`,
      referrer: null,
    });
    if (error) {
      console.error('[LINE Restock] 신청 저장 실패:', error.message);
      return res.status(500).json({ error: 'failed' });
    }
  }

  const friend = await isFriend(session.lineUserId);
  return res.status(200).json({ ok: true, already, friend });
}

// ─── GET: 발송 (크론) ─────────────────────────────────────────────────────────

async function dispatch(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const enabled = process.env.LINE_RESTOCK_ENABLED === '1';
  const now = Date.now();

  if (!dryRun && !enabled) return res.status(200).json({ ok: true, skipped: 'LINE_RESTOCK_ENABLED 미설정' });
  if (!dryRun && inQuietHours(new Date(now))) {
    // 버리지 않는다. 다음 실행에서 같은 신청이 다시 잡힌다.
    return res.status(200).json({ ok: true, skipped: '조용한 시간 (JST 21~09시)' });
  }

  // 🔴 중복 방지가 이 기록 위에 선다. 기록이 없으면 매시간 같은 사람에게 다시 보낸다.
  const db = supabase();
  if (!db) return res.status(500).json({ error: '발송 기록 저장소가 없어 중단했습니다' });

  try {
    const pending = await pendingSubscriptions(db, now);
    const states = pending.length
      ? await fetchVariantStates(await getAdminToken(), [...new Set(pending.map((s) => s.variantId))])
      : new Map<string, VariantState>();

    const ready = pending.filter((s) => states.get(s.variantId)?.available);

    // 한 사람에게 한 통 — 같은 실행에 옵션 여러 개가 같이 풀렸으면 한 메시지에 묶는다
    const byUser = new Map<string, Subscription[]>();
    for (const s of ready) byUser.set(s.lineUserId, [...(byUser.get(s.lineUserId) ?? []), s]);
    const targets = [...byUser.entries()].slice(0, MAX_PER_RUN).map(([userId, subs]) => ({
      userId,
      subs,
      text: buildRestockMessage(subs.map((s) => states.get(s.variantId)!)),
    }));

    const result = {
      ok: true,
      dryRun,
      enabled,
      pending: pending.length,
      // 신청은 남아 있는데 옵션이 삭제된 것 — 늘어나면 상품 정리 때 신청이 버려지고 있다는 뜻
      missing: pending.filter((s) => !states.has(s.variantId)).length,
      ready: ready.length,
      willSend: targets.length,
      sent: 0,
      notFriend: 0,
      failed: 0,
      samples: targets.slice(0, 2).map((t) => t.text),
    };
    if (dryRun || targets.length === 0) return res.status(200).json(result);

    // LINE 월 발송 한도. 모자라면 아예 보내지 않고 다음 실행으로 미룬다 — 일부만 보내면
    // 한도가 바닥난 뒤의 주문·배송 알림까지 같이 막힌다(2026-09-24 한도 소진 때 실제로 그랬다).
    const quota = await fetchQuota().catch(() => null);
    if (quota && quota.remaining !== null && quota.remaining < targets.length) {
      console.error(`[LINE Restock] 🔴 월 한도 부족 — 남은 ${quota.remaining}통 < 보낼 ${targets.length}명. 보류합니다`);
      return res.status(200).json({ ...result, skipped: '월 발송 한도 부족' });
    }

    for (const t of targets) {
      // 직렬로 보낸다. 병렬은 레이트리밋에 걸리고 어디까지 나갔는지도 흐려진다.
      const r = await pushLine(t.userId, t.text);
      if (r === 'failed') {
        result.failed++;
        continue;
      }
      if (r === 'sent') result.sent++;
      else result.notFriend++;
      // 친구가 아니어도 기록한다 — 다시 시도해도 같은 결과라 매시간 재시도하지 않도록
      for (const s of t.subs) {
        await recordSends([t.userId], {
          campaignId: `journey_${JOURNEY}`,
          journey: JOURNEY,
          kind: 'transactional',
          ref: s.ref,
          name: '재입고 알림',
          utm: UTM,
          delivery: r,
        });
      }
    }

    console.log(`[LINE Restock] 발송 ${result.sent}건 · 친구아님 ${result.notFriend} · 실패 ${result.failed}`);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[LINE Restock] Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : '재입고 알림 실행 중 오류' });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST') {
    try {
      return await subscribe(req, res);
    } catch (error) {
      console.error('[LINE Restock] 신청 오류:', error);
      return res.status(500).json({ error: 'failed' });
    }
  }
  if (req.method === 'GET' && req.query.view === 'admin') {
    try {
      return await adminList(req, res);
    } catch (error) {
      console.error('[LINE Restock] 어드민 목록 오류:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
    }
  }
  if (req.method === 'GET') return dispatch(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}
