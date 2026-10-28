import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { createSign } from 'crypto';

/**
 * 어드민 「사이트 성과」 리포트 (#264) — biteme-promotion 「플랫폼 성과」 틀을 일본몰에 맞춘 것.
 *
 *  GET /api/site-report?days=7|30|90   (Authorization: Bearer ADMIN_SECRET)
 *
 * 기간은 오늘을 빼고 어제까지(JST). 두 출처를 섞는다:
 *  - GA4  : 유입 경로(채널·소스/매체) · 구매 퍼널(이벤트별 고객) · 일별 추이 · 요약
 *  - events 표(자체 track) : 메인 화면 구좌 — 구좌별 클릭 세션과 「같은 세션 안 주문」
 *
 * events 의 세션 = 탭 하나(sessionStorage). 주문은 주문 웹훅이 카트 속성 bm_sid 로 같은 세션에 남긴 order_paid
 * (2026-10-28 배포부터) + 결제 뒤 사이트로 돌아온 order_complete. 그 전 주문은 구좌와 못 잇는다 — 화면 각주에 적는다.
 *
 * 같은 기간을 여러 번 열면 GA4·DB 를 다시 안 부르게 함수 인스턴스 안에 30분 캐시. `fresh=1` 이면 새로.
 */

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || '';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const ALLOWED_ORIGINS = ['https://biteme.co.jp', 'https://www.biteme.co.jp', 'https://bitemejp-admin.vercel.app', 'http://localhost:5173'];
const PREVIEW_ORIGIN = /^https:\/\/bitemejp(-admin)?(-git-[a-z0-9-]+)?-biteme\.vercel\.app$/;

const DAY_OPTIONS = [7, 30, 90] as const;
/** events 표를 읽는 상한 — 넘으면 truncated 로 알린다(90일 실측 9만 줄대) */
const MAX_EVENT_ROWS = 600_000;
/** 기간을 이 날수씩 잘라 종류×구간을 동시에 읽는다 — 90일 한 줄로 읽으면 40초 넘게 걸림 */
const WINDOW_DAYS = 15;
const READ_CONCURRENCY = 12;
const CACHE_TTL_MS = 30 * 60_000;

// ─── GA4 ─────────────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;
  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const iat = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(input);
  const jwt = `${input}.${sign.sign(sa.private_key, 'base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Token error: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken!;
}

interface GA4Report {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
}
type Row = Record<string, string | number>;

async function runReport(token: string, body: object): Promise<Row[]> {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const report = (await res.json()) as GA4Report;
  const dims = (report.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (report.metricHeaders ?? []).map((h) => h.name);
  return (report.rows ?? []).map((r) => {
    const o: Row = {};
    dims.forEach((d, i) => { o[d] = r.dimensionValues?.[i]?.value ?? ''; });
    mets.forEach((m, i) => { o[m] = Number(r.metricValues?.[i]?.value ?? 0); });
    return o;
  });
}

const num = (r: Row | undefined, k: string) => Number(r?.[k] ?? 0);

/** 퍼널 단계 — GA4 이벤트별 고객 수(순서 강제 없음) */
const FUNNEL_STEPS = [
  { event: 'session_start', label: '사이트 방문' },
  { event: 'view_item', label: '상품 상세 조회' },
  { event: 'add_to_cart', label: '장바구니 담기' },
  { event: 'begin_checkout', label: '결제 시작' },
  { event: 'purchase', label: '구매' },
] as const;

async function ga4Part(days: number) {
  const token = await getAccessToken();
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];
  const trafficMetrics = [
    { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'addToCarts' },
    { name: 'transactions' }, { name: 'purchaseRevenue' },
  ];
  const [summary, channels, sources, funnel, daily, devices] = await Promise.all([
    runReport(token, { dateRanges, metrics: trafficMetrics }),
    runReport(token, { dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: trafficMetrics, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] }),
    runReport(token, { dateRanges, dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }], metrics: trafficMetrics, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 20 }),
    runReport(token, {
      dateRanges,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'totalUsers' }, { name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_STEPS.map((s) => s.event) } } },
    }),
    runReport(token, { dateRanges, dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'transactions' }, { name: 'purchaseRevenue' }], orderBys: [{ dimension: { dimensionName: 'date' } }] }),
    runReport(token, { dateRanges, dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }, { name: 'transactions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] }),
  ]);

  const traffic = (r: Row) => ({
    sessions: num(r, 'sessions'),
    users: num(r, 'totalUsers'),
    newUsers: num(r, 'newUsers'),
    addToCarts: num(r, 'addToCarts'),
    transactions: num(r, 'transactions'),
    revenue: Math.round(num(r, 'purchaseRevenue')),
  });
  const byEvent = new Map(funnel.map((r) => [String(r.eventName), r]));
  return {
    summary: traffic(summary[0] ?? {}),
    channels: channels.map((r) => ({ channel: String(r.sessionDefaultChannelGroup), ...traffic(r) })),
    sources: sources.map((r) => ({ source: String(r.sessionSource), medium: String(r.sessionMedium), ...traffic(r) })),
    funnel: FUNNEL_STEPS.map((s) => ({ step: s.event, label: s.label, users: num(byEvent.get(s.event), 'totalUsers') })),
    daily: daily.map((r) => ({ date: String(r.date), sessions: num(r, 'sessions'), transactions: num(r, 'transactions'), revenue: Math.round(num(r, 'purchaseRevenue')) })),
    devices: devices.map((r) => ({ device: String(r.deviceCategory), sessions: num(r, 'sessions'), transactions: num(r, 'transactions') })),
  };
}

// ─── 메인 화면 구좌 (events 표) ──────────────────────────────────────────────

/** 구좌 정의 — 화면 순서대로. key 는 이벤트에서 classify() 가 고른다 */
const SLOTS = [
  { key: 'banner', label: '메인 배너', item: '배너' },
  { key: 'category_icon', label: '카테고리 아이콘', item: '카테고리' },
  { key: 'affiliate', label: '어필리에이트 배너', item: '배너' },
  { key: 'new', label: '신상품 줄', item: '상품' },
  { key: 'category_section', label: '카테고리별 상품 줄', item: '상품' },
  { key: 'popular', label: '인기 상품 줄', item: '상품' },
  { key: 'instagram', label: '인스타 릴스', item: '릴스' },
  { key: 'grid', label: '전체 상품 목록', item: '상품' },
  { key: 'category_nav', label: '상단 카테고리 메뉴', item: '카테고리' },
  { key: 'affiliate_link', label: '메뉴·푸터 어필리에이트 링크', item: '위치' },
  { key: 'product_legacy', label: '상품 클릭 (구좌 구분 전)', item: '상품' },
] as const;
type SlotKey = (typeof SLOTS)[number]['key'];

/** order_paid = 주문 웹훅이 카트 속성 bm_sid 로 남긴 주문(#264). order_complete = 결제 뒤 사이트 복귀(예전 방식) */
const EVENT_TYPES = ['page_view', 'banner_click', 'category_click', 'product_click', 'promo_click', 'reel_click', 'checkout_start', 'order_complete', 'order_paid'];

interface EventRow {
  event_type: string;
  session_id: string;
  properties: Record<string, unknown> | null;
  page_path: string | null;
  created_at: string;
}

function classify(e: EventRow): { slot: SlotKey; item: string } | null {
  const p = e.properties ?? {};
  const s = (v: unknown, fallback = '(이름 없음)') => (typeof v === 'string' && v.trim() ? v.trim() : v != null && v !== '' ? String(v) : fallback);
  switch (e.event_type) {
    case 'banner_click':
      return { slot: 'banner', item: s(p.banner_title) };
    case 'category_click':
      return { slot: p.source === 'home_circles' ? 'category_icon' : 'category_nav', item: s(p.name ?? p.handle) };
    case 'promo_click':
      if (p.slot === 'affiliate') return { slot: 'affiliate', item: '어필리에이트 모집' };
      if (p.slot === 'affiliate_menu') return { slot: 'affiliate_link', item: '헤더 메뉴' };
      if (p.slot === 'affiliate_footer') return { slot: 'affiliate_link', item: '푸터' };
      if (p.slot === 'instagram') return { slot: 'instagram', item: '인스타 계정 링크' };
      return null;
    case 'reel_click':
      return { slot: 'instagram', item: `릴스 ${s(p.reel_id)}` };
    case 'product_click': {
      const item = s(p.product_title);
      const src = p.source;
      if (src === 'home_new') return { slot: 'new', item };
      if (src === 'home_category') return { slot: 'category_section', item };
      if (src === 'popular') return { slot: 'popular', item };
      if (src === 'grid') return { slot: 'grid', item };
      // 구좌 구분(source) 붙기 전 이벤트 — 캐러셀 이름으로 알 수 있는 것만
      if (p.collection === 'new') return { slot: 'new', item };
      if (p.collection === 'best_selling') return { slot: 'popular', item };
      return { slot: 'product_legacy', item };
    }
    default:
      return null;
  }
}

/** JST 자정 기준 [from, to) — to = 오늘 0시 */
function jstRange(days: number) {
  const DAY = 86_400_000;
  const jstNow = Date.now() + 9 * 3_600_000;
  const todayStartUtc = Math.floor(jstNow / DAY) * DAY - 9 * 3_600_000;
  const from = new Date(todayStartUtc - days * DAY);
  const to = new Date(todayStartUtc);
  const ymd = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  return { from, to, fromYmd: ymd(from), toYmd: ymd(new Date(to.getTime() - DAY)) };
}

async function slotPart(from: Date, to: Date) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  // 색인이 (event_type, created_at) 이라 종류를 섞어 시각순으로 읽으면 전체 정렬 → statement timeout.
  // 종류 하나 × 기간 구간 하나씩, 마지막 created_at 다음부터(keyset) 읽는다. 같은 시각(마이크로초)이
  // 페이지 경계에 걸리면 한 줄 빠질 수 있지만 집계엔 영향 없는 수준
  let truncated = false;
  let total = 0;
  const readChunk = async (type: string, start: Date, end: Date): Promise<EventRow[]> => {
    const out: EventRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      if (total >= MAX_EVENT_ROWS) { truncated = true; break; }
      let q = sb
        .from('events')
        .select('event_type, session_id, properties, page_path, created_at')
        .eq('event_type', type)
        .lt('created_at', end.toISOString());
      q = cursor ? q.gt('created_at', cursor) : q.gte('created_at', start.toISOString());
      const { data, error } = await q.order('created_at', { ascending: true }).limit(1000);
      if (error) throw new Error(`events(${type}): ${error.message}`);
      const page = (data ?? []) as EventRow[];
      out.push(...page);
      total += page.length;
      if (page.length < 1000) break;
      cursor = page[page.length - 1].created_at;
    }
    return out;
  };
  const jobs: (() => Promise<EventRow[]>)[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += WINDOW_DAYS * 86_400_000) {
    const ws = new Date(t);
    const we = new Date(Math.min(to.getTime(), t + WINDOW_DAYS * 86_400_000));
    for (const type of EVENT_TYPES) jobs.push(() => readChunk(type, ws, we));
  }
  const chunks: EventRow[][] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      chunks[i] = await jobs[i]();
    }
  }));
  // 시각순이어야 「클릭 뒤 주문」을 가릴 수 있다 — 합친 뒤 정렬
  const rows = chunks.flat().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  // 세션별 — 메인 진입·결제 시작·주문(시각·금액)
  const homeSessions = new Set<string>();
  const checkoutAt = new Map<string, number[]>();
  const orders = new Map<string, { at: number; value: number }[]>();
  const seenOrders = new Set<string>();
  for (const e of rows) {
    const at = Date.parse(e.created_at);
    if (e.event_type === 'page_view' && (e.page_path ?? '').split('?')[0] === '/') homeSessions.add(e.session_id);
    if (e.event_type === 'checkout_start') checkoutAt.set(e.session_id, [...(checkoutAt.get(e.session_id) ?? []), at]);
    if (e.event_type === 'order_complete' || e.event_type === 'order_paid') {
      const p = e.properties ?? {};
      // 같은 주문이 웹훅 재전송·복귀 페이지로 두 번 남을 수 있다 — 주문 번호로 한 번만
      const oid = String(p.order_number ?? p.order_id ?? '').replace(/^shopify_/, '').replace(/^#/, '');
      if (oid) {
        if (seenOrders.has(oid)) continue;
        seenOrders.add(oid);
      }
      const v = Number(p.order_value ?? 0);
      orders.set(e.session_id, [...(orders.get(e.session_id) ?? []), { at, value: Number.isFinite(v) ? v : 0 }]);
    }
  }

  interface Agg { clicks: number; sessions: Map<string, number> } // 세션 → 그 구좌 첫 클릭 시각
  const newAgg = (): Agg => ({ clicks: 0, sessions: new Map() });
  const slotAgg = new Map<SlotKey, Agg>();
  const itemAgg = new Map<SlotKey, Map<string, Agg>>();
  const anyClick = new Map<string, number>();
  const bump = (a: Agg, sid: string, at: number) => {
    a.clicks += 1;
    const prev = a.sessions.get(sid);
    if (prev === undefined || at < prev) a.sessions.set(sid, at);
  };
  for (const e of rows) {
    const c = classify(e);
    if (!c) continue;
    const at = Date.parse(e.created_at);
    if (!slotAgg.has(c.slot)) slotAgg.set(c.slot, newAgg());
    bump(slotAgg.get(c.slot)!, e.session_id, at);
    if (!itemAgg.has(c.slot)) itemAgg.set(c.slot, new Map());
    const items = itemAgg.get(c.slot)!;
    if (!items.has(c.item)) items.set(c.item, newAgg());
    bump(items.get(c.item)!, e.session_id, at);
    const prev = anyClick.get(e.session_id);
    if (prev === undefined || at < prev) anyClick.set(e.session_id, at);
  }

  /** 클릭 뒤 같은 세션 주문 — 세션 수와 금액 */
  const after = (a: Agg) => {
    let checkoutSessions = 0;
    let orderSessions = 0;
    let orderValue = 0;
    for (const [sid, first] of a.sessions) {
      if ((checkoutAt.get(sid) ?? []).some((t) => t >= first)) checkoutSessions += 1;
      const os = (orders.get(sid) ?? []).filter((o) => o.at >= first);
      if (os.length) {
        orderSessions += 1;
        orderValue += os.reduce((s, o) => s + o.value, 0);
      }
    }
    return { clicks: a.clicks, sessions: a.sessions.size, checkoutSessions, orderSessions, orderValue: Math.round(orderValue) };
  };

  const slots = SLOTS.filter((s) => slotAgg.has(s.key) || s.key !== 'product_legacy').map((s) => {
    const a = slotAgg.get(s.key) ?? newAgg();
    const items = [...(itemAgg.get(s.key) ?? new Map<string, Agg>()).entries()]
      .map(([label, ia]) => ({ label, ...after(ia) }))
      .sort((x, y) => y.sessions - x.sessions || y.clicks - x.clicks);
    return {
      key: s.key,
      label: s.label,
      itemLabel: s.item,
      ...after(a),
      items: items.slice(0, 30),
      itemsMore: Math.max(0, items.length - 30),
    };
  });

  // 자체 이벤트 세션 퍼널 — 앞 단계를 모두 거친 세션만
  const clicked = new Set(anyClick.keys());
  const step1 = homeSessions;
  const step2 = [...step1].filter((s) => clicked.has(s));
  const step3 = step2.filter((s) => (checkoutAt.get(s) ?? []).length > 0);
  const step4 = step3.filter((s) => (orders.get(s) ?? []).length > 0);

  return {
    homeSessions: homeSessions.size,
    eventRows: rows.length,
    truncated,
    slots,
    sessionFunnel: [
      { step: 'home', label: '메인 화면 진입', sessions: step1.size },
      { step: 'click', label: '메인 구좌 클릭', sessions: step2.length },
      { step: 'checkout', label: '결제 시작', sessions: step3.length },
      { step: 'order', label: '주문 완료', sessions: step4.length },
    ],
  };
}

// ─── handler ─────────────────────────────────────────────────────────────────

const cache = new Map<number, { at: number; body: unknown }>();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN.test(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!ADMIN_SECRET || req.headers.authorization !== `Bearer ${ADMIN_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Cache-Control', 'private, no-store');

  const asked = Number(req.query.days);
  const days = (DAY_OPTIONS as readonly number[]).includes(asked) ? asked : 30;
  const hit = cache.get(days);
  if (hit && req.query.fresh !== '1' && Date.now() - hit.at < CACHE_TTL_MS) return res.status(200).json(hit.body);

  const range = jstRange(days);
  try {
    const [ga4, slots] = await Promise.allSettled([
      GA4_PROPERTY_ID && GOOGLE_SERVICE_ACCOUNT_JSON ? ga4Part(days) : Promise.reject(new Error('GA4 설정 없음')),
      slotPart(range.from, range.to),
    ]);
    const body = {
      days,
      from: range.fromYmd,
      to: range.toYmd,
      generatedAt: new Date().toISOString(),
      ga4: ga4.status === 'fulfilled' ? ga4.value : null,
      ga4Error: ga4.status === 'rejected' ? String(ga4.reason instanceof Error ? ga4.reason.message : ga4.reason) : null,
      site: slots.status === 'fulfilled' ? slots.value : null,
      siteError: slots.status === 'rejected' ? String(slots.reason instanceof Error ? slots.reason.message : slots.reason) : null,
    };
    // 한쪽이라도 성공했을 때만 캐시 — 둘 다 실패면 다음 요청에서 다시
    if (body.ga4 || body.site) cache.set(days, { at: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[site-report]', e);
    return res.status(500).json({ error: e instanceof Error ? e.message : 'failed' });
  }
}
