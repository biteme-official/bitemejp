/**
 * /api/line-campaign — LINE 타겟 발송 (관리자 전용)
 *
 * LINE 공식계정 매니저의 브로드캐스트는 LINE 이 가진 속성(성별·연령·지역·친구기간)으로만
 * 대상을 나눌 수 있다. "구매한 적 있는 사람", "가입만 하고 안 산 사람" 같은 **우리 데이터
 * 기준 세그먼트**는 거기서 만들 수 없어서, 연결된 고객(`line_member`)을 Shopify 에서
 * 추출해 Messaging API 의 multicast 로 직접 보낸다.
 *
 * ⚠️ 이 엔드포인트는 사람에게 메시지를 실제로 보낸다. 되돌릴 수 없다.
 *    - 실발송은 `confirm: true` 를 명시해야만 실행된다
 *    - `testUserIds` 를 주면 그 사람들에게만 간다 (문안·링크 눈으로 확인용)
 *    - 남은 쿼터보다 대상이 많으면 보내지 않는다
 *    - 같은 campaignId 로 두 번 보내지 않는다
 *
 * ⚠️ LINE userId 는 개인식별자다. preview 응답에 절대 싣지 않는다.
 *    발송 시에도 프론트가 보낸 대상 목록을 믿지 않고 서버가 조건으로 다시 추출한다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const SHOPIFY_API_VERSION = '2025-07';
const PLACEHOLDER_EMAIL_DOMAIN = '@line-user.biteme.co.jp';
const SOURCE_TAG_PREFIX = 'line_src:';
const LINE_ID_TAG_PREFIX = 'line_id:';

/** LINE multicast 1회 최대 수신자 */
const MULTICAST_CHUNK = 500;
/** 실수로 대량 발송하는 것을 막는 상한. 늘려야 하면 코드에서 올린다(화면에서 못 넘긴다). */
const MAX_RECIPIENTS = 2000;
/** 캠페인 단위 발송 이력 (Supabase `events` 테이블 재사용) */
const CAMPAIGN_EVENT = 'line_campaign';
/** 수신자 단위 발송 기록. 빈도 제한과 저니 중복 방지가 전부 이 기록 위에 선다. */
export const SEND_EVENT = 'line_send';

/**
 * 한 사람이 받는 마케팅 메시지 상한.
 *
 * ⚠️ 주문 확인·배송 알림은 여기 넣지 않는다. 넣으면 물건을 산 사람이 배송 알림을
 *    못 받는다 — 한도에 걸려 조용히 사라지는 게 하필 가장 중요한 메시지가 된다.
 */
export const FREQUENCY_CAPS = { day: 1, week: 2, month: 6 } as const;

/** 발송하지 않는 시간대 (JST). 걸리면 버리지 않고 다음 창까지 미룬다. */
export const QUIET_HOURS = { from: 21, to: 9 } as const;

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

// ─── 세그먼트 ────────────────────────────────────────────────────────────────

interface Segment {
  /** 구매 이력 */
  purchase?: 'any' | 'buyers' | 'non_buyers';
  /** 가입 N일 이내 (신규) */
  signupWithinDays?: number | null;
  /** 가입 N일 경과 (휴면 후보) */
  signupBeforeDays?: number | null;
  /** 실제 이메일 보유 여부. placeholder = 주문 확인 메일이 도달하지 않는 사람들 */
  email?: 'any' | 'real' | 'placeholder';
  /** 유입경로 태그(`line_src:*`)의 값. 'none' 이면 태그가 없는 사람 */
  source?: string | null;
  /** 누적 구매액 하한 (엔) */
  minSpent?: number | null;
}

interface Member {
  gid: string;
  lineUserId: string | null;
  createdAt: string;
  orders: number;
  spent: number;
  hasRealEmail: boolean;
  source: string | null;
}

function matchesSegment(m: Member, s: Segment, now: number): boolean {
  const purchase = s.purchase ?? 'any';
  if (purchase === 'buyers' && m.orders <= 0) return false;
  if (purchase === 'non_buyers' && m.orders > 0) return false;

  const email = s.email ?? 'any';
  if (email === 'real' && !m.hasRealEmail) return false;
  if (email === 'placeholder' && m.hasRealEmail) return false;

  if (typeof s.minSpent === 'number' && m.spent < s.minSpent) return false;

  const ageDays = (now - new Date(m.createdAt).getTime()) / 86_400_000;
  if (typeof s.signupWithinDays === 'number' && ageDays > s.signupWithinDays) return false;
  if (typeof s.signupBeforeDays === 'number' && ageDays < s.signupBeforeDays) return false;

  if (s.source) {
    if (s.source === 'none' ? m.source !== null : m.source !== s.source) return false;
  }

  return true;
}

// ─── Shopify ─────────────────────────────────────────────────────────────────

export async function getAdminToken(): Promise<string> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!shop || !clientId || !clientSecret) throw new Error('Missing Admin API env vars');

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Admin token failed: ${res.status}`);
  return (await res.json()).access_token;
}

export async function adminGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as T;
}

interface AudienceNode {
  id: string;
  createdAt: string;
  tags: string[];
  email: string | null;
  /** Admin API 의 UnsignedInt64 는 문자열로 온다 */
  numberOfOrders: string;
  amountSpent: { amount: string } | null;
  metafield: { value: string } | null;
}

interface AudienceResponse {
  data?: {
    customers?: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      edges: { node: AudienceNode }[];
    };
  };
  errors?: unknown;
}

const AUDIENCE_QUERY = `
  query LineAudience($cursor: String) {
    customers(first: 250, after: $cursor, query: "tag:line_member") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          tags
          email
          numberOfOrders
          amountSpent { amount }
          metafield(namespace: "custom", key: "line_id") { value }
        }
      }
    }
  }
`;

/**
 * LINE userId 를 찾는다.
 *
 * ⚠️ 셋 다 봐야 한다. 메타필드가 정본이지만, 매핑 이전에 가입한 사람은 태그에만 있고,
 *    태그도 없으면 자리표시자 이메일의 로컬파트(`line_{userId}@…`)가 마지막 단서다.
 *    실제 이메일을 등록하면 이 마지막 단서는 사라진다.
 */
function resolveLineUserId(node: {
  metafield?: { value?: string } | null;
  tags?: string[];
  email?: string | null;
}): string | null {
  const fromMetafield = node.metafield?.value?.trim();
  if (fromMetafield) return fromMetafield;

  const tag = (node.tags ?? []).find((t) => t.startsWith(LINE_ID_TAG_PREFIX));
  if (tag) return tag.slice(LINE_ID_TAG_PREFIX.length);

  const email = node.email ?? '';
  if (email.endsWith(PLACEHOLDER_EMAIL_DOMAIN) && email.startsWith('line_')) {
    return email.slice('line_'.length, email.length - PLACEHOLDER_EMAIL_DOMAIN.length);
  }
  return null;
}

async function fetchAudience(): Promise<Member[]> {
  const token = await getAdminToken();
  const members: Member[] = [];
  let cursor: string | null = null;

  for (;;) {
    const res = await adminGraphQL<AudienceResponse>(token, AUDIENCE_QUERY, { cursor });
    const conn = res?.data?.customers;
    if (!conn) throw new Error(`고객 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 300)}`);

    for (const edge of conn.edges) {
      const n = edge.node;
      const tags: string[] = n.tags ?? [];
      const src = tags.find((t: string) => t.startsWith(SOURCE_TAG_PREFIX));
      members.push({
        gid: n.id,
        lineUserId: resolveLineUserId(n),
        createdAt: n.createdAt,
        orders: Number(n.numberOfOrders ?? 0),
        spent: Number(n.amountSpent?.amount ?? 0),
        hasRealEmail: !!n.email && !String(n.email).endsWith(PLACEHOLDER_EMAIL_DOMAIN),
        source: src ? src.slice(SOURCE_TAG_PREFIX.length) : null,
      });
    }

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return members;
}

// ─── LINE ────────────────────────────────────────────────────────────────────

export function lineToken(): string {
  const token = process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN 미설정');
  return token;
}

export async function lineGet<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${lineToken()}` },
  });
  if (!res.ok) throw new Error(`LINE ${path} ${res.status}`);
  return (await res.json()) as T;
}

interface FollowerInsight {
  followers?: number;
  targetedReaches?: number;
  blocks?: number;
}

interface QuotaInfo {
  limit: number | null;
  used: number;
  remaining: number | null;
}

export async function fetchQuota(): Promise<QuotaInfo> {
  const [quota, consumption] = await Promise.all([
    lineGet<{ type?: string; value?: number }>('/v2/bot/message/quota'),
    lineGet<{ totalUsage?: number }>('/v2/bot/message/quota/consumption'),
  ]);
  // type:'none' 이면 무제한 플랜이라 value 가 없다
  const limit = typeof quota?.value === 'number' ? quota.value : null;
  const used = Number(consumption?.totalUsage ?? 0);
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

/**
 * 재시도 키. 같은 캠페인·같은 묶음이면 항상 같은 값이라, 네트워크 오류로 다시 쏴도
 * LINE 이 중복 발송을 막아준다. UUID 형식이어야 받아준다.
 */
function retryKey(campaignId: string, chunkIndex: number): string {
  const h = createHash('sha256').update(`${campaignId}#${chunkIndex}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join('-');
}

async function multicast(
  userIds: string[],
  text: string,
  campaignId: string,
  chunkIndex: number,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch('https://api.line.me/v2/bot/message/multicast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${lineToken()}`,
      'X-Line-Retry-Key': retryKey(campaignId, chunkIndex),
    },
    body: JSON.stringify({ to: userIds, messages: [{ type: 'text', text }] }),
  });
  const body = res.ok ? '' : (await res.text()).slice(0, 300);
  return { ok: res.ok, status: res.status, body };
}

// ─── 메시지 ──────────────────────────────────────────────────────────────────

/**
 * 링크에 UTM 을 붙인다.
 *
 * 규칙은 이미 쓰고 있는 실측 형식을 그대로 따른다 — `line / line / YYMMDD_line_<소재>`.
 * 이걸 지켜야 index.html 이 sessionStorage 에 담고 → 체크아웃 장바구니 속성 →
 * Shopify 주문 `customAttributes` 까지 이어져서 **발송이 만든 매출**이 잡힌다.
 */
function withUtm(rawUrl: string, campaign: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set('utm_source', 'line');
  url.searchParams.set('utm_medium', 'line');
  url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}

/** 발송 기준 시간대는 일본(JST). UTC 로 만들면 밤 발송이 하루 전 날짜가 된다. */
function jstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 캠페인 ID·UTM 용 (260821) */
export function yymmdd(d = new Date()): string {
  return jstDate(d).slice(2).replace(/-/g, '');
}

/** LINE 인사이트 API 용 (20260821). ⚠️ 6자리를 넘기면 조용히 빈 응답이 온다. */
function yyyymmdd(d: Date): string {
  return jstDate(d).replace(/-/g, '');
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯-]/g, '').slice(0, 40);
}

interface MessageInput {
  /** 소재명 — 캠페인 ID·UTM campaign 에 쓰인다 */
  name?: string;
  text?: string;
  /** 본문 끝에 붙일 링크. UTM 은 서버가 붙인다 */
  url?: string;
}

function buildMessage(input: MessageInput): { text: string; campaignId: string; campaign: string } {
  const text = (input.text ?? '').trim();
  if (!text) throw new Error('본문(text)이 비어 있습니다');
  if (text.length > 900) throw new Error('본문이 900자를 넘습니다');

  const slug = slugify(input.name ?? '') || 'campaign';
  const date = yymmdd();
  const campaign = `${date}_line_${slug}`;
  const campaignId = `${date}_${slug}`;

  let full = text;
  if (input.url) {
    let link: string;
    try {
      link = withUtm(input.url, campaign);
    } catch {
      throw new Error('링크 형식이 올바르지 않습니다');
    }
    full = `${text}\n\n${link}`;
  }
  if (full.length > 1000) throw new Error('링크를 붙인 본문이 1,000자를 넘습니다');

  return { text: full, campaignId, campaign };
}

// ─── 발송 이력 (Supabase `events` 재사용) ────────────────────────────────────

export function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * 수신자 한 명당 한 행을 남긴다. 빈도 제한·저니 중복 방지가 전부 이 기록을 읽는다.
 *
 * ⚠️ 메시지는 이미 나간 뒤에 기록한다. 기록이 실패해도 발송을 되돌릴 수 없으므로
 *    예외를 삼키되 반드시 로그를 남긴다 — 기록이 비면 그 사람은 오늘 안 받은 것으로
 *    취급돼 한도를 넘겨 또 받을 수 있다.
 */
export async function recordSends(
  userIds: string[],
  meta: {
    campaignId: string;
    journey?: string;
    kind: 'marketing' | 'transactional';
    ref?: string;
    /** 화면에 보여줄 이름. 없으면 campaignId 로 대체된다 */
    name?: string | null;
    /**
     * 이 발송이 심은 `utm_campaign` 값.
     * ⚠️ 발송할 때 같이 남겨야 나중에 주문과 맞출 수 있다. 나중에 캠페인 이력에서
     *    유추하려 하면 소재명이 겹치거나 바뀐 캠페인에서 어긋난다.
     */
    utm?: string | null;
  },
): Promise<void> {
  if (userIds.length === 0) return;
  const db = supabase();
  if (!db) {
    console.error('[LINE Send] 🔴 SUPABASE 미설정 — 수신자 기록이 남지 않았습니다:', meta.campaignId);
    return;
  }
  const rows = userIds.map((u) => ({
    event_type: SEND_EVENT,
    session_id: `line:${u}`,
    properties: meta as unknown as Record<string, unknown>,
    page_path: meta.journey ? `/journey/${meta.journey}` : '/admin',
    referrer: null,
  }));
  const { error } = await db.from('events').insert(rows);
  if (error) console.error('[LINE Send] 🔴 수신자 기록 실패(중복 발송 위험):', error.message);
}

interface CapResult {
  allowed: string[];
  /** 한도에 걸려 이번에는 보내지 않는 사람 */
  capped: string[];
  reasons: Record<string, 'day' | 'week' | 'month'>;
}

/**
 * 최근 30일 마케팅 발송 기록을 읽어 한도를 넘는 사람을 걸러낸다.
 *
 * 대상 목록으로 `in` 필터를 걸지 않는다 — 수백 명이면 쿼리 문자열이 터진다.
 * 기간으로만 긁어서(월 1천 행 남짓) 메모리에서 센다.
 */
export async function applyFrequencyCap(userIds: string[], now = Date.now()): Promise<CapResult> {
  const empty: CapResult = { allowed: userIds, capped: [], reasons: {} };
  const db = supabase();
  if (!db) {
    console.error('[LINE Send] 🔴 SUPABASE 미설정 — 빈도 제한을 확인하지 못했습니다');
    return empty;
  }

  const monthAgo = new Date(now - 30 * 86_400_000).toISOString();
  const { data, error } = await db
    .from('events')
    .select('session_id, created_at, properties')
    .eq('event_type', SEND_EVENT)
    .gte('created_at', monthAgo);

  if (error) {
    // 확인이 안 되는 것과 한도를 넘긴 것은 다르다. 여기서 전부 막으면 이력 장애가 발송을 멈춘다.
    console.error('[LINE Send] 🔴 빈도 제한 조회 실패, 제한 없이 진행합니다:', error.message);
    return empty;
  }

  const rows = (data ?? []) as {
    session_id: string;
    created_at: string;
    properties: { kind?: string } | null;
  }[];

  const counts = new Map<string, { day: number; week: number; month: number }>();
  for (const row of rows) {
    if (row.properties?.kind === 'transactional') continue;
    const id = row.session_id.startsWith('line:') ? row.session_id.slice(5) : row.session_id;
    const age = now - new Date(row.created_at).getTime();
    const c = counts.get(id) ?? { day: 0, week: 0, month: 0 };
    if (age <= 86_400_000) c.day++;
    if (age <= 7 * 86_400_000) c.week++;
    c.month++;
    counts.set(id, c);
  }

  const result: CapResult = { allowed: [], capped: [], reasons: {} };
  for (const id of userIds) {
    const c = counts.get(id);
    const hit = !c
      ? null
      : c.day >= FREQUENCY_CAPS.day
        ? 'day'
        : c.week >= FREQUENCY_CAPS.week
          ? 'week'
          : c.month >= FREQUENCY_CAPS.month
            ? 'month'
            : null;
    if (hit) {
      result.capped.push(id);
      result.reasons[id] = hit;
    } else {
      result.allowed.push(id);
    }
  }
  return result;
}

/** 지금이 발송하지 않는 시간대인지 (JST 기준) */
export function inQuietHours(now = new Date()): boolean {
  const jstHour = new Date(now.getTime() + 9 * 3600_000).getUTCHours();
  return jstHour >= QUIET_HOURS.from || jstHour < QUIET_HOURS.to;
}

async function recentCampaigns(limit = 20) {
  const db = supabase();
  if (!db) return [];
  const { data, error } = await db
    .from('events')
    .select('created_at, properties')
    .eq('event_type', CAMPAIGN_EVENT)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[LINE Campaign] 이력 조회 실패:', error.message);
    return [];
  }
  const rows = (data ?? []) as { created_at: string; properties: Record<string, unknown> | null }[];
  return rows.map((row) => ({ sentAt: row.created_at, ...(row.properties ?? {}) }));
}

async function alreadySent(campaignId: string): Promise<boolean> {
  const db = supabase();
  if (!db) return false;
  const { data, error } = await db
    .from('events')
    .select('id')
    .eq('event_type', CAMPAIGN_EVENT)
    .eq('session_id', `campaign:${campaignId}`)
    .limit(1);
  if (error) {
    // 확인이 안 되면 막지 않는다 — 대신 로그로 남긴다. 여기서 막으면 이력 장애가 발송을 막는다.
    console.error('[LINE Campaign] 중복 확인 실패:', error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

async function logCampaign(campaignId: string, properties: Record<string, unknown>): Promise<void> {
  const db = supabase();
  if (!db) {
    console.error('[LINE Campaign] 🔴 SUPABASE 미설정 — 발송 이력이 남지 않았습니다:', campaignId);
    return;
  }
  const { error } = await db.from('events').insert({
    event_type: CAMPAIGN_EVENT,
    session_id: `campaign:${campaignId}`,
    properties,
    page_path: '/admin',
    referrer: null,
  });
  // 이력 실패가 발송 결과를 뒤집지는 않는다. 메시지는 이미 나갔다.
  if (error) console.error('[LINE Campaign] 🔴 이력 기록 실패(중복 발송 위험):', error.message);
}

// ─── 저니 회수 성과 ──────────────────────────────────────────────────────────

/**
 * 캠페인이 실제로 매출을 만들었는지.
 *
 * 기여를 **두 가지로 나눠 센다.** 하나만 쓰면 둘 다 거짓말이 된다.
 *
 *   회수  = 발송 후 72시간 안에 그 사람이 주문했다.
 *           원래 살 사람이 섞이므로 **상한**이다. 특히 장바구니 이탈은 그냥 돌아올 사람이 많다.
 *   클릭  = 그 캠페인이 심은 UTM 을 달고 들어와 주문했다.
 *           확실히 이 발송이 데려온 것이므로 **하한**이다. 링크 없는 발송은 셀 수 없다(null).
 *
 * 진짜 값은 둘 사이에 있다. 한 숫자만 보여주면 과대평가하거나 과소평가하게 된다.
 */
const ATTRIBUTION_HOURS = 72;

interface CampaignStat {
  key: string;
  /** broadcast = 공식계정 매니저에서 보낸 것. 우리 발송 기록이 없어 UTM 으로만 잡힌다 */
  kind: 'journey' | 'manual' | 'broadcast';
  label: string;
  firstSentAt: string;
  /** 보낸 인원. 매니저 발송은 통수를 알 수 없어 null */
  sent: number | null;
  /** 발송 후 72시간 내 주문 (상한) */
  recovered: number;
  revenue: number;
  /** 회수율 (%) */
  rate: number | null;
  /** UTM 을 달고 들어온 주문 (하한). 링크가 없던 발송은 null */
  clicked: number | null;
  clickRevenue: number | null;
}

/**
 * 공식계정 매니저에서 보낸 브로드캐스트를 알아보는 규칙.
 *
 * 매니저 발송은 우리 기록에 남지 않지만 링크에 `YYMMDD_line_<소재>` 형식의 UTM 을 달고 있어서
 * 주문 쪽에서 역으로 잡힌다. 월 21,000통을 쓰는 채널인데 지금까지 성과가 어디에도 없었다.
 */
const BROADCAST_UTM = /^\d{6}_line_/;

interface OrderRow {
  at: number;
  total: number;
  customerGid: string | null;
  utm: string | null;
}

async function fetchOrders(sinceMs: number): Promise<OrderRow[]> {
  const token = await getAdminToken();
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);
  const out: OrderRow[] = [];
  let cursor: string | null = null;

  for (;;) {
    const res = await adminGraphQL<{
      data?: {
        orders?: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: {
            node: {
              createdAt: string;
              customer: { id: string } | null;
              currentTotalPriceSet: { shopMoney: { amount: string } } | null;
              customAttributes: { key: string; value: string | null }[];
            };
          }[];
        };
      };
    }>(
      token,
      `query CampaignOrders($cursor: String, $q: String) {
        orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            createdAt
            customer { id }
            currentTotalPriceSet { shopMoney { amount } }
            customAttributes { key value }
          } }
        }
      }`,
      { cursor, q: `created_at:>=${sinceDay}` },
    );
    const conn = res?.data?.orders;
    if (!conn) break;
    for (const e of conn.edges) {
      const utm = (e.node.customAttributes ?? []).find((a) => a.key === 'utm_campaign')?.value ?? null;
      out.push({
        at: new Date(e.node.createdAt).getTime(),
        total: Number(e.node.currentTotalPriceSet?.shopMoney?.amount ?? 0),
        customerGid: e.node.customer?.id ?? null,
        utm,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return out;
}

async function campaignStats(members: Member[], days = 30): Promise<CampaignStat[]> {
  const db = supabase();
  if (!db) return [];

  const since = Date.now() - days * 86_400_000;
  const { data, error } = await db
    .from('events')
    .select('session_id, created_at, properties')
    .eq('event_type', SEND_EVENT)
    .gte('created_at', new Date(since).toISOString());
  if (error) {
    console.error('[LINE Campaign] 발송 성과 조회 실패:', error.message);
    return [];
  }

  interface SendRow {
    journey?: string;
    campaignId?: string;
    name?: string | null;
    utm?: string | null;
    kind?: string;
  }

  const sends = ((data ?? []) as {
    session_id: string;
    created_at: string;
    properties: SendRow | null;
  }[])
    .filter((r) => {
      const p = r.properties;
      if (!p) return false;
      if (p.kind === 'transactional') return false;
      // 테스트 발송은 문안 확인용이라 성과에서 뺀다 — 넣으면 전환율이 흐려진다
      return !p.campaignId?.endsWith('_test');
    })
    .map((r) => ({
      p: r.properties!,
      userId: r.session_id.startsWith('line:') ? r.session_id.slice(5) : r.session_id,
      at: new Date(r.created_at).getTime(),
    }));

  if (sends.length === 0) return [];

  const gidByUser = new Map<string, string>();
  for (const m of members) if (m.lineUserId) gidByUser.set(m.lineUserId, m.gid);

  const orders = await fetchOrders(since);
  const ordersByCustomer = new Map<string, OrderRow[]>();
  const ordersByUtm = new Map<string, { count: number; revenue: number }>();
  for (const o of orders) {
    if (o.customerGid) {
      const list = ordersByCustomer.get(o.customerGid) ?? [];
      list.push(o);
      ordersByCustomer.set(o.customerGid, list);
    }
    if (o.utm) {
      const agg = ordersByUtm.get(o.utm) ?? { count: 0, revenue: 0 };
      agg.count++;
      agg.revenue += o.total;
      ordersByUtm.set(o.utm, agg);
    }
  }

  interface Agg {
    kind: 'journey' | 'manual';
    label: string;
    firstSentAt: number;
    sent: number;
    recovered: number;
    revenue: number;
    utms: Set<string>;
  }
  const byCampaign = new Map<string, Agg>();

  for (const s of sends) {
    const key = s.p.journey ?? s.p.campaignId ?? 'unknown';
    const agg: Agg = byCampaign.get(key) ?? {
      kind: s.p.journey ? 'journey' : 'manual',
      label: s.p.journey ?? s.p.name ?? s.p.campaignId ?? key,
      firstSentAt: s.at,
      sent: 0,
      recovered: 0,
      revenue: 0,
      utms: new Set<string>(),
    };
    agg.sent++;
    agg.firstSentAt = Math.min(agg.firstSentAt, s.at);
    if (s.p.utm) agg.utms.add(s.p.utm);

    const gid = gidByUser.get(s.userId);
    const hit = gid
      ? (ordersByCustomer.get(gid) ?? []).find(
          (o) => o.at > s.at && o.at <= s.at + ATTRIBUTION_HOURS * 3600_000,
        )
      : undefined;
    if (hit) {
      agg.recovered++;
      agg.revenue += hit.total;
    }
    byCampaign.set(key, agg);
  }

  // 우리 기록에 없는데 UTM 만 있는 라인 캠페인 = 매니저에서 보낸 브로드캐스트.
  // 발송 통수는 알 수 없지만 그게 만든 주문은 셀 수 있다.
  const ownUtms = new Set<string>();
  for (const v of byCampaign.values()) for (const u of v.utms) ownUtms.add(u);

  const broadcasts: CampaignStat[] = [];
  for (const [utm, agg] of ordersByUtm) {
    if (ownUtms.has(utm) || !BROADCAST_UTM.test(utm)) continue;
    broadcasts.push({
      key: utm,
      kind: 'broadcast',
      label: utm.replace(/^(\d{2})(\d{2})(\d{2})_line_/, ''),
      // 발송일은 UTM 앞 6자리(YYMMDD)로 읽는다 — 우리가 보낸 게 아니라 기록이 없다
      firstSentAt: `20${utm.slice(0, 2)}-${utm.slice(2, 4)}-${utm.slice(4, 6)}T00:00:00.000Z`,
      sent: null,
      recovered: 0,
      revenue: 0,
      rate: null,
      clicked: agg.count,
      clickRevenue: Math.round(agg.revenue),
    });
  }

  return [...byCampaign.entries()]
    .map(([key, v]): CampaignStat => {
      // 링크를 심지 않은 발송은 클릭 기여를 셀 방법이 없다. 0 이 아니라 null 이어야
      // 화면에서 "0건"과 "셀 수 없음"이 구분된다.
      let clicked: number | null = null;
      let clickRevenue: number | null = null;
      if (v.utms.size > 0) {
        clicked = 0;
        clickRevenue = 0;
        for (const u of v.utms) {
          const agg = ordersByUtm.get(u);
          if (agg) {
            clicked += agg.count;
            clickRevenue += agg.revenue;
          }
        }
      }
      return {
        key,
        kind: v.kind,
        label: v.label,
        firstSentAt: new Date(v.firstSentAt).toISOString(),
        sent: v.sent,
        recovered: v.recovered,
        revenue: Math.round(v.revenue),
        rate: v.sent > 0 ? Math.round((v.recovered / v.sent) * 1000) / 10 : 0,
        clicked,
        clickRevenue: clickRevenue === null ? null : Math.round(clickRevenue),
      };
    })
    .concat(broadcasts)
    .sort((a, b) => b.firstSentAt.localeCompare(a.firstSentAt));
}

// ─── 집계 ────────────────────────────────────────────────────────────────────

function summarize(members: Member[]) {
  const bySource: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  let buyers = 0;
  let realEmail = 0;
  let spent = 0;
  let unreachable = 0;

  for (const m of members) {
    if (m.orders > 0) buyers++;
    if (m.hasRealEmail) realEmail++;
    if (!m.lineUserId) unreachable++;
    spent += m.spent;
    const src = m.source ?? '(없음)';
    bySource[src] = (bySource[src] ?? 0) + 1;
    const month = m.createdAt.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }

  return {
    count: members.length,
    buyers,
    nonBuyers: members.length - buyers,
    realEmail,
    placeholderEmail: members.length - realEmail,
    /** userId 를 못 찾아 보낼 수 없는 사람 */
    unreachable,
    totalSpent: Math.round(spent),
    bySource,
    byMonth,
  };
}

// ─── 핸들러 ──────────────────────────────────────────────────────────────────

function unauthorized(req: VercelRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  return !secret || req.headers.authorization !== `Bearer ${secret}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (unauthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const [quota, followers, history] = await Promise.all([
        fetchQuota(),
        // 인사이트는 2일 지연된다 — 오늘 날짜로 부르면 항상 비어 있다
        lineGet<FollowerInsight>(
          `/v2/bot/insight/followers?date=${yyyymmdd(new Date(Date.now() - 3 * 86_400_000))}`,
        ).catch(() => null),
        recentCampaigns(),
      ]);
      const audience = await fetchAudience();
      const campaigns = await campaignStats(audience).catch((err) => {
        console.error('[LINE Campaign] 발송 성과 계산 실패:', err);
        return [];
      });
      return res.status(200).json({
        ok: true,
        quota,
        followers: followers
          ? {
              followers: followers.followers,
              targetedReaches: followers.targetedReaches,
              blocks: followers.blocks,
            }
          : null,
        audience: summarize(audience),
        campaigns,
        attributionHours: ATTRIBUTION_HOURS,
        journeyEnabled: !!process.env.LINE_JOURNEY_ENABLED,
        history,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action, segment = {}, message = {}, confirm, testUserIds } = (req.body ?? {}) as {
      action?: string;
      segment?: Segment;
      message?: MessageInput;
      confirm?: boolean;
      testUserIds?: string[];
    };

    const now = Date.now();
    const audience = await fetchAudience();
    const matched = audience.filter((m) => matchesSegment(m, segment, now));

    if (action === 'preview') {
      let preview: { text: string; campaign: string; campaignId: string } | null = null;
      let messageError: string | null = null;
      try {
        preview = buildMessage(message);
      } catch (err) {
        messageError = err instanceof Error ? err.message : '본문 확인 실패';
      }
      return res.status(200).json({
        ok: true,
        total: audience.length,
        matched: summarize(matched),
        preview,
        messageError,
      });
    }

    if (action !== 'send') return res.status(400).json({ error: 'action 은 preview 또는 send 입니다' });

    // ── 여기부터는 실제로 사람에게 메시지가 나간다 ──
    const built = buildMessage(message);
    const isTest = Array.isArray(testUserIds) && testUserIds.length > 0;

    if (!confirm) {
      return res.status(400).json({ error: '실발송에는 confirm: true 가 필요합니다' });
    }

    const candidates = isTest
      ? Array.from(new Set(testUserIds.filter((id) => typeof id === 'string' && id.startsWith('U'))))
      : Array.from(new Set(matched.map((m) => m.lineUserId).filter((id): id is string => !!id)));

    // 테스트 발송은 문안 확인용이라 한도를 적용하지 않는다 — 걸리면 확인 자체가 막힌다.
    const cap = isTest ? { allowed: candidates, capped: [] as string[] } : await applyFrequencyCap(candidates);
    const recipients = cap.allowed;

    if (recipients.length === 0) {
      return res.status(400).json({
        error:
          cap.capped.length > 0
            ? `대상 ${candidates.length}명이 전부 최근 수신 한도에 걸려 있습니다`
            : '보낼 대상이 없습니다',
      });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return res
        .status(400)
        .json({ error: `1회 발송 상한(${MAX_RECIPIENTS}명)을 넘었습니다: ${recipients.length}명` });
    }

    const quota = await fetchQuota();
    if (quota.remaining !== null && quota.remaining < recipients.length) {
      return res.status(400).json({
        error: `남은 쿼터가 부족합니다 — 잔여 ${quota.remaining}통 / 대상 ${recipients.length}명`,
      });
    }

    // 테스트 발송은 같은 문안을 여러 번 보내는 게 정상이라 중복 검사에서 뺀다
    const campaignId = isTest ? `${built.campaignId}_test` : built.campaignId;
    if (!isTest && (await alreadySent(campaignId))) {
      return res
        .status(409)
        .json({ error: `이미 보낸 캠페인입니다: ${campaignId}. 소재명을 바꾸면 새 캠페인이 됩니다` });
    }

    const chunks: string[][] = [];
    for (let i = 0; i < recipients.length; i += MULTICAST_CHUNK) {
      chunks.push(recipients.slice(i, i + MULTICAST_CHUNK));
    }

    let sent = 0;
    const delivered: string[] = [];
    const failures: { chunk: number; status: number; body: string }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      // 직렬로 보낸다. 병렬은 레이트리밋에 걸리고, 어디까지 나갔는지도 흐려진다.
      const result = await multicast(chunks[i], built.text, campaignId, i);
      if (result.ok) {
        sent += chunks[i].length;
        delivered.push(...chunks[i]);
      } else {
        failures.push({ chunk: i, status: result.status, body: result.body });
        console.error(`[LINE Campaign] 🔴 묶음 ${i} 실패 ${result.status}: ${result.body}`);
      }
    }

    // 실제로 나간 사람만 기록한다 — 실패한 묶음까지 세면 다음 발송에서 애먼 사람이 한도에 걸린다
    await recordSends(delivered, {
      campaignId,
      kind: 'marketing',
      name: message.name ?? null,
      utm: message.url ? built.campaign : null,
    });

    const record = {
      campaignId,
      campaign: built.campaign,
      name: message.name ?? null,
      test: isTest,
      segment,
      recipients: recipients.length,
      capped: cap.capped.length,
      sent,
      failedChunks: failures.length,
      url: message.url ?? null,
      textLength: built.text.length,
    };
    await logCampaign(campaignId, record);

    return res.status(failures.length > 0 ? 207 : 200).json({ ok: failures.length === 0, ...record, failures });
  } catch (error) {
    console.error('[LINE Campaign] Error:', error);
    return res
      .status(500)
      .json({ error: error instanceof Error ? error.message : '발송 처리 중 오류가 발생했습니다' });
  }
}
