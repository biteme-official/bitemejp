/**
 * /api/line-journey — 트리거로 도는 LINE 자동 발송
 *
 * 저니 세 갈래가 우선순위 순으로 돈다.
 *   1. cart_recovery      장바구니 이탈 복구 — 결제창까지 갔다가 이탈 (신호가 가장 강하다).
 *   2. cart_add           장바구니 담기 이탈 — 담기만 하고 결제창에 안 간 사람.
 *                         Shopify 는 결제창 이탈만 기록해서 여기가 통째로 사각지대였다.
 *                         2026-09-04 담기 이벤트 때 담기 293→1,341 인데 결제창 이탈은 15→16.
 *                         카트 스냅샷은 `/api/line-cart` 가 남긴다.
 *   3. first_purchase_d1  연결 다음날 첫 구매 유도 — 볼륨이 가장 크다(월 약 300통).
 *
 * ⚠️ 순서가 곧 우선순위다. 빈도 제한이 하루 1통이라 같은 사람에게 둘 다 나가지 않고,
 *    **먼저 도는 쪽이 가져간다.** 진 쪽은 지금 그냥 사라진다 — 설계의 "3일 대기 후 폐기"는
 *    아직 구현하지 않았다. 저니가 늘어나면 그때 만들어야 한다.
 *
 * ⚠️ 사람에게 메시지가 나가는 크론이다. 기본은 꺼져 있다.
 *    - `LINE_JOURNEY_ENABLED` 에 적힌 저니만 돈다 (예: `cart_recovery,first_purchase_d1` · `all`)
 *    - `?dryRun=1` 은 "지금 켜면 누구에게 무엇이 나가는지" 만 돌려준다
 *    - 조용한 시간(JST 21~09시)에는 보내지 않고 다음 실행으로 넘긴다
 *    - 인당 수신 한도와 대상당 1회 규칙을 지킨다
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Member } from './line-campaign.js';
import {
  SEND_EVENT,
  adminGraphQL,
  applyFrequencyCap,
  fetchAudience,
  getAdminToken,
  inQuietHours,
  lineToken,
  recordSends,
  supabase,
} from './line-campaign.js';
import { allowedTarget, signClick } from './line-click.js';
import { CART_EVENT, type CartLine } from './line-cart.js';

const CART_RECOVERY = 'cart_recovery';
const CART_ADD = 'cart_add';
const FIRST_PURCHASE = 'first_purchase_d1';

/** 순서 = 우선순위. 앞에 있는 저니가 먼저 대상을 가져간다. */
const JOURNEY_ORDER = [CART_RECOVERY, CART_ADD, FIRST_PURCHASE] as const;

/**
 * 담기 이탈로 인정하는 구간.
 *
 * 결제창 이탈보다 뒤를 길게 잡는다(1h → 3h). 담기 직후는 아직 쇼핑 중일 때가 많아서
 * 1시간 만에 말을 걸면 "보고 있는 중인데 왜"가 된다.
 * 20시간까지 여는 건 조용한 시간(21~09) 때문이다 — 저녁에 담고 간 사람을 아침에 주워야 한다.
 */
const CART_ADD_MIN_H = 3;
const CART_ADD_MAX_H = 20;

/** 연결 후 이만큼 지난 사람에게 첫 구매를 권한다. 24시간을 안 두면 가입 직후에 또 말을 건다. */
const FIRST_PURCHASE_MIN_H = 24;
const FIRST_PURCHASE_MAX_H = 48;

/**
 * 첫 구매 유도 링크.
 *
 * `/discount/<코드>` 는 클릭 시점에 코드를 심어주므로, 로그인 때 심긴 쿠폰이 사라진
 * 기기에서도 결제창에서 자동 적용된다. UTM 은 날짜를 넣지 않는다 — 상시로 도는 저니라
 * 날짜를 넣으면 성과가 하루 단위로 잘게 쪼개진다.
 */
const FIRST_PURCHASE_UTM = 'line_firstbuy_d1';
const FIRST_PURCHASE_URL =
  `https://biteme.co.jp/discount/WELCOME10?utm_source=line&utm_medium=line&utm_campaign=${FIRST_PURCHASE_UTM}`;

/**
 * 이탈로 인정하는 구간.
 *
 * 1시간을 안 기다리면 "잠깐 다른 탭 보는 중"인 사람에게 알림이 간다.
 * 뒤를 14시간까지 여는 건 조용한 시간(21~09시) 때문이다 — 밤에 담아두고 간 사람을
 * 아침 첫 실행에서 주워야 한다. 이 창이 좁으면 밤 이탈은 통째로 사라진다.
 */
const MIN_AGE_HOURS = 1;
const MAX_AGE_HOURS = 14;

/** 클릭 추적 링크가 사는 곳. myshopify 주소보다 이쪽이 고객에게 훨씬 덜 낯설다. */
const CLICK_ORIGIN = 'https://biteme.co.jp';

/** 한 번 실행에 보낼 수 있는 최대 인원 — 폭주 방지 */
const MAX_PER_RUN = 100;

interface Candidate {
  checkoutId: string;
  createdAt: string;
  /** 지금 기준 몇 시간 전 이탈인가 */
  ageH: number;
  lineUserId: string;
  customerGid: string;
  recoveryUrl: string;
  itemTitle: string | null;
  itemCount: number;
}

interface AbandonedResponse {
  data?: {
    abandonedCheckouts?: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      edges: {
        node: {
          id: string;
          createdAt: string;
          abandonedCheckoutUrl: string | null;
          customer: {
            id: string;
            tags: string[];
            email: string | null;
            metafield: { value: string } | null;
          } | null;
          lineItems: { edges: { node: { title: string; quantity: number } }[] };
        };
      }[];
    };
  };
  errors?: unknown;
}

const PLACEHOLDER_EMAIL_DOMAIN = '@line-user.biteme.co.jp';
const LINE_ID_TAG_PREFIX = 'line_id:';

/** api/line-campaign.ts 와 같은 규칙 — 메타필드 → 태그 → 자리표시자 이메일 순 */
function resolveLineUserId(c: {
  metafield: { value: string } | null;
  tags: string[];
  email: string | null;
}): string | null {
  const meta = c.metafield?.value?.trim();
  if (meta) return meta;
  const tag = (c.tags ?? []).find((t) => t.startsWith(LINE_ID_TAG_PREFIX));
  if (tag) return tag.slice(LINE_ID_TAG_PREFIX.length);
  const email = c.email ?? '';
  if (email.endsWith(PLACEHOLDER_EMAIL_DOMAIN) && email.startsWith('line_')) {
    return email.slice('line_'.length, email.length - PLACEHOLDER_EMAIL_DOMAIN.length);
  }
  return null;
}

/**
 * 결제창 이탈을 읽어 온다. **나이로 거르지 않는다** — 저니마다 쓰는 창이 다르기 때문이다.
 *   · 복구 저니(저니 1)는 1~14시간짜리만 쓰고
 *   · 담기 저니(저니 2)는 "결제창까지 갔는가"를 판정하는 데 전 구간이 필요하다.
 *     여기서 좁게 잘라 두면, 방금 결제창에 들어간 사람에게 담기 저니가 먼저 말을 걸고
 *     하루 1통 한도 때문에 정작 신호가 강한 복구 저니가 막힌다.
 */
async function fetchCandidates(token: string, now: number): Promise<Candidate[]> {
  const lookbackH = Math.max(MAX_AGE_HOURS, CART_ADD_MAX_H);
  const since = new Date(now - lookbackH * 3600_000).toISOString().slice(0, 10);
  const out: Candidate[] = [];
  let cursor: string | null = null;

  for (;;) {
    const res = await adminGraphQL<AbandonedResponse>(
      token,
      `query CartRecovery($cursor: String, $q: String) {
        abandonedCheckouts(first: 100, after: $cursor, query: $q) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id
            createdAt
            abandonedCheckoutUrl
            customer {
              id
              tags
              email
              metafield(namespace: "custom", key: "line_id") { value }
            }
            lineItems(first: 3) { edges { node { title quantity } } }
          } }
        }
      }`,
      { cursor, q: `created_at:>=${since}` },
    );

    const conn = res?.data?.abandonedCheckouts;
    if (!conn) throw new Error(`이탈 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 300)}`);

    for (const edge of conn.edges) {
      const n = edge.node;
      const ageH = (now - new Date(n.createdAt).getTime()) / 3600_000;
      if (ageH < 0 || ageH > lookbackH) continue;
      if (!n.abandonedCheckoutUrl || !n.customer) continue;
      if (!(n.customer.tags ?? []).includes('line_member')) continue;

      const lineUserId = resolveLineUserId(n.customer);
      if (!lineUserId) continue;

      const items = n.lineItems?.edges ?? [];
      out.push({
        checkoutId: n.id,
        createdAt: n.createdAt,
        ageH,
        lineUserId,
        customerGid: n.customer.id,
        recoveryUrl: n.abandonedCheckoutUrl,
        itemTitle: items[0]?.node?.title ?? null,
        itemCount: items.reduce((s, e) => s + (e.node.quantity ?? 1), 0),
      });
    }

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return out;
}

/**
 * 이탈 뒤에 결국 산 사람을 뺀다.
 *
 * ⚠️ 이게 없으면 방금 결제한 사람에게 "장바구니가 남아 있다"고 보낸다.
 *    대기했다 보낼 때도 이 확인을 다시 해야 한다 — 조건은 대기하는 동안 바뀐다.
 */
async function fetchRecentBuyers(token: string, now: number): Promise<Set<string>> {
  const since = new Date(now - (MAX_AGE_HOURS + 2) * 3600_000).toISOString();
  const res = await adminGraphQL<{
    data?: { orders?: { edges: { node: { createdAt: string; customer: { id: string } | null } }[] } };
  }>(
    token,
    `query RecentBuyers($q: String) {
      orders(first: 250, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { node { createdAt customer { id } } }
      }
    }`,
    { q: `created_at:>=${since.slice(0, 10)}` },
  );
  const set = new Set<string>();
  for (const e of res?.data?.orders?.edges ?? []) {
    if (e.node.customer?.id) set.add(e.node.customer.id);
  }
  return set;
}

/** 이 저니로 이미 보낸 대상(ref) 집합. 체크아웃당·사람당 1회를 이걸로 지킨다. */
async function alreadyHandled(journey: string): Promise<Set<string>> {
  const db = supabase();
  if (!db) return new Set();
  const since = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const { data, error } = await db
    .from('events')
    .select('properties')
    .eq('event_type', SEND_EVENT)
    .gte('created_at', since);
  if (error) {
    // 확인이 안 되면 보내지 않는다. 여기서는 조용히 통과시키면 중복 발송이 된다.
    throw new Error(`중복 확인 실패: ${error.message}`);
  }
  const set = new Set<string>();
  for (const row of (data ?? []) as { properties: { journey?: string; ref?: string } | null }[]) {
    if (row.properties?.journey === journey && row.properties.ref) set.add(row.properties.ref);
  }
  return set;
}

/**
 * 문안. 쿠폰을 붙이지 않는다 — 이탈하면 할인이 온다는 걸 학습시키면 정가 구매가 사라진다.
 * 링크는 Shopify 가 주는 복구 URL 이라 담아둔 장바구니가 그대로 열린다.
 */
/**
 * 복구 링크를 클릭 추적 링크로 바꾼다.
 *
 * 도착지는 그대로다 — 우리 도메인을 한 번 거치면서 "눌렀다"는 사실만 남긴다.
 * 그게 이 저니의 유일한 하한 지표가 된다(주문에 UTM 이 안 붙으므로).
 *
 * ⚠️ 조금이라도 예상과 다르면 **추적을 포기하고 원래 링크를 그대로 보낸다.**
 *    성과 지표 하나 때문에 복구 링크를 못 열게 만드는 것이 훨씬 큰 손해다.
 */
export function trackedUrl(recoveryUrl: string, checkoutId: string): string {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return recoveryUrl;
  // 리다이렉트가 되받아 줄 수 있는 주소가 아니면 감싸지 않는다 — 감쌌다가 못 열면 그게 손실이다
  if (!allowedTarget(recoveryUrl)) return recoveryUrl;
  const ref = checkoutId.split('/').pop();
  if (!ref) return recoveryUrl;
  return `${CLICK_ORIGIN}/api/line-click?t=${signClick(recoveryUrl, ref, secret)}`;
}

function buildMessage(c: Candidate, url: string): string {
  const item = c.itemTitle
    ? `「${c.itemTitle}」${c.itemCount > 1 ? ` ほか${c.itemCount - 1}点` : ''}`
    : 'お選びいただいた商品';

  return [
    'カートに商品が残っています🐾',
    '',
    'BITE ME JAPANです。',
    `${item}をお取り置きしています。`,
    '',
    '在庫には限りがございますので、',
    'お早めにご確認ください。',
    '',
    '▼ カートを開く',
    url,
  ].join('\n');
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
  console.error(`[LINE Journey] 🔴 push 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return 'failed';
}

/**
 * ⚠️ `x-vercel-cron` 헤더를 인증으로 쓰지 않는다. 아무나 붙여 보낼 수 있는 평범한 헤더라
 *    그것만 보면 이 발송 엔드포인트가 외부에 통째로 열린다(실측으로 확인, #147).
 *    Vercel 크론은 `CRON_SECRET` 이 설정돼 있을 때 `Authorization: Bearer <secret>` 를 붙여 온다.
 */
function authorized(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (process.env.ADMIN_SECRET && auth === `Bearer ${process.env.ADMIN_SECRET}`) return true;
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  return false;
}

interface RunResult {
  journey: string;
  found: number;
  willSend: number;
  sent: number;
  notFriend: number;
  failed: number;
  capped: number;
  excluded: Record<string, number>;
  samples: { text: string; note?: string }[];
}

/** 저니 1 — 장바구니 이탈 복구 */
async function runCartRecovery(
  token: string,
  now: number,
  dryRun: boolean,
  abandoned: Candidate[],
  buyers: Set<string>,
): Promise<RunResult> {
  const handled = await alreadyHandled(CART_RECOVERY);

  const candidates = abandoned.filter((c) => c.ageH >= MIN_AGE_HOURS && c.ageH <= MAX_AGE_HOURS);

  const fresh = candidates.filter((c) => !buyers.has(c.customerGid) && !handled.has(c.checkoutId));

  // 같은 사람이 여러 번 이탈했으면 가장 최근 것 하나만
  const perUser = new Map<string, Candidate>();
  for (const c of fresh) {
    const prev = perUser.get(c.lineUserId);
    if (!prev || new Date(c.createdAt) > new Date(prev.createdAt)) perUser.set(c.lineUserId, c);
  }

  const cap = await applyFrequencyCap([...perUser.keys()], now);
  const targets = cap.allowed.map((id) => perUser.get(id)!).slice(0, MAX_PER_RUN);

  const base: RunResult = {
    journey: CART_RECOVERY,
    found: candidates.length,
    willSend: targets.length,
    sent: 0,
    notFriend: 0,
    failed: 0,
    capped: cap.capped.length,
    excluded: {
      구매함: candidates.filter((c) => buyers.has(c.customerGid)).length,
      이미발송: candidates.filter((c) => handled.has(c.checkoutId)).length,
      수신한도: cap.capped.length,
    },
    // userId 는 싣지 않는다. 문안은 실제로 나갈 것 그대로 보여준다.
    // 실제로 나갈 링크(추적 링크) 그대로 보여준다 — 문안 확인이 링크 확인을 겸해야 한다
    samples: targets.slice(0, 2).map((c) => ({
      text: buildMessage(c, trackedUrl(c.recoveryUrl, c.checkoutId)),
      note: `이탈 ${c.createdAt}`,
    })),
  };
  if (dryRun) return base;

  const delivered: { userId: string; ref: string }[] = [];
  for (const c of targets) {
    // 직렬로 보낸다. 병렬은 레이트리밋에 걸리고 어디까지 나갔는지도 흐려진다.
    const result = await pushLine(c.lineUserId, buildMessage(c, trackedUrl(c.recoveryUrl, c.checkoutId)));
    if (result === 'sent') {
      base.sent++;
      delivered.push({ userId: c.lineUserId, ref: c.checkoutId });
    } else if (result === 'not-friend') {
      base.notFriend++;
      // 친구가 아니면 다시 시도해도 같은 결과다. 재시도하지 않도록 기록은 남긴다.
      delivered.push({ userId: c.lineUserId, ref: c.checkoutId });
    } else {
      base.failed++;
    }
  }

  for (const d of delivered) {
    await recordSends([d.userId], {
      campaignId: `journey_${CART_RECOVERY}`,
      journey: CART_RECOVERY,
      kind: 'marketing',
      ref: d.ref,
      name: '장바구니 이탈 복구',
      // 복구 링크는 Shopify 도메인이라 UTM 을 붙여도 우리 프론트를 거치지 않는다.
      // 그래서 이 저니의 하한은 UTM 이 아니라 **클릭**으로 센다 (`/api/line-click`).
      utm: null,
      clickTracked: true,
    });
  }
  return base;
}

/* ─── 저니 2 — 장바구니 담기 이탈 ─────────────────────────────────────────────
 *
 * 결제창 이탈(저니 1)이 못 보는 구간을 맡는다. 담기만 하고 결제창에 안 간 사람.
 * 트리거는 Shopify 가 아니라 우리 카트 스냅샷(`/api/line-cart`)이다.
 */

/** 스냅샷에서 사람마다 마지막 카트 하나만 남긴다. 빈 카트면 "비웠다"라서 대상이 아니다. */
interface CartSnapshot {
  lineUserId: string;
  at: number;
  items: CartLine[];
}

/** 한 번에 읽는 스냅샷 행 수 상한. 지금 규모(하루 수백 줄)의 열 배쯤 잡아 둔다. */
const SNAPSHOT_ROW_LIMIT = 10000;

async function fetchCartSnapshots(now: number): Promise<CartSnapshot[]> {
  const db = supabase();
  if (!db) return [];

  // 창보다 넉넉히 읽는다 — 창 밖의 더 최신 스냅샷이 있으면 그 사람은 대상이 아니어야 한다
  const since = new Date(now - (CART_ADD_MAX_H + 6) * 3600_000).toISOString();
  // 🔴 정렬과 상한을 명시한다. PostgREST 는 기본 상한(보통 1,000행)에서 **조용히** 자르는데,
  //    카트는 바뀔 때마다 한 줄씩 쌓여서 로그인 쇼핑객이 늘면 금방 넘는다.
  //    최신순으로 자르면 잘리는 쪽이 항상 '더 오래된 행'이라, 사람마다 마지막 카트를
  //    고르는 이 로직에서는 아예 안 잡힐 뿐 **엉뚱한 옛 카트가 뽑히지는 않는다**.
  const { data, error } = await db
    .from('events')
    .select('session_id, created_at, properties')
    .eq('event_type', CART_EVENT)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SNAPSHOT_ROW_LIMIT);
  if (error) throw new Error(`카트 스냅샷 조회 실패: ${error.message}`);

  const latest = new Map<string, CartSnapshot>();
  for (const row of (data ?? []) as {
    session_id: string;
    created_at: string;
    properties: { items?: CartLine[] } | null;
  }[]) {
    if (!row.session_id.startsWith('line:')) continue;
    const lineUserId = row.session_id.slice(5);
    const at = new Date(row.created_at).getTime();
    const prev = latest.get(lineUserId);
    if (prev && prev.at >= at) continue;
    latest.set(lineUserId, { lineUserId, at, items: row.properties?.items ?? [] });
  }
  return [...latest.values()];
}

/**
 * 카트 구성을 나타내는 열쇠. 중복 발송을 막는 `ref` 로 쓴다.
 *
 * 사람 단위로 막으면 다음 주에 다른 상품을 담아도 영영 못 보낸다. 카트 구성이 바뀌면
 * 새 의도라 다시 보낼 수 있어야 하고, 그래도 주 2통 한도가 상한을 잡는다.
 */
function cartKey(lineUserId: string, items: CartLine[]): string {
  const sig = items
    .map((i) => `${i.variantId.split('/').pop()}x${i.quantity}`)
    .sort()
    .join(',');
  return `${lineUserId}|${sig}`;
}

/** 담기 이탈 복구 링크 — 우리 사이트에서 카트를 그대로 되살린다(로그인·쿠폰 상태 유지). */
export function cartRestoreUrl(items: CartLine[]): string {
  const c = items
    .map((i) => `${i.productId.split('/').pop()}:${i.variantId.split('/').pop()}:${i.quantity}`)
    .join(',');
  const url = new URL('https://biteme.co.jp/cart/restore');
  url.searchParams.set('c', c);
  url.searchParams.set('utm_source', 'line');
  url.searchParams.set('utm_medium', 'line');
  url.searchParams.set('utm_campaign', CART_ADD_UTM);
  return url.toString();
}

const CART_ADD_UTM = 'line_cart_add';

/** 문안에 들어가는 값에서 개행·제어문자를 걷어낸다. 상품명은 브라우저가 보낸 값이다. */
function stripControl(v: string): string {
  return [...v].map((ch) => (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! === 0x7f ? ' ' : ch)).join('');
}

/**
 * 문안. 결제창 이탈과 마찬가지로 쿠폰을 붙이지 않는다 —
 * 담아두면 할인이 온다는 걸 학습시키면 정가 구매가 사라진다.
 */
export function buildCartAddMessage(items: CartLine[], url: string): string {
  // 상품명은 브라우저가 보낸 값이라 그대로 문안에 넣지 않는다. 개행이 섞이면
  // 메시지 모양이 무너진다(피해는 본인 한정이지만 고객이 보는 문장이다).
  const first = stripControl(items[0]?.title ?? '').trim();
  // 「ほかN点」은 줄 수가 아니라 총 수량 − 1 이다 — 복구 저니(buildMessage)의 itemCount 와 같은 기준.
  // 한 줄에 3개를 담아도 「ほか2点」이 맞다.
  const rest = items.reduce((n, i) => n + i.quantity, 0) - 1;
  const what = first
    ? `「${first}」${rest > 0 ? ` ほか${rest}点` : ''}`
    : 'お選びいただいた商品';

  return [
    'カートに商品が入ったままです🐾',
    '',
    'BITE ME JAPANです。',
    `${what}をお預かりしています。`,
    '',
    'ご注文手続きはまだ完了していません。',
    '下のリンクからそのまま進めます。',
    '',
    '▼ カートを開く',
    url,
  ].join('\n');
}

/**
 * 담기 저니의 선별 규칙만 떼어낸 순수 함수.
 *
 * 발송 조건이 다섯 겹이라(창·비움·결제창·구매·중복) 규칙이 하나만 어긋나도
 * 엉뚱한 사람에게 나간다. 네트워크 없이 시험할 수 있어야 해서 밖으로 뺐다.
 */
export function selectCartAddTargets(input: {
  snapshots: CartSnapshot[];
  now: number;
  /** 결제창까지 간 사람 — 저니 1 의 몫 */
  checkoutReached: Set<string>;
  /** 최근 주문한 고객 gid */
  buyers: Set<string>;
  gidByLine: Map<string, string>;
  /** 이미 이 카트 구성으로 보낸 ref */
  handled: Set<string>;
}): {
  inWindow: number;
  emptied: number;
  reachedCheckout: number;
  bought: number;
  alreadySent: number;
  fresh: CartSnapshot[];
} {
  const { snapshots, now, checkoutReached, buyers, gidByLine, handled } = input;

  const inWindow = snapshots.filter((s) => {
    const ageH = (now - s.at) / 3600_000;
    return ageH >= CART_ADD_MIN_H && ageH <= CART_ADD_MAX_H;
  });

  // 사람당 하나로 접는다. fetchCartSnapshots 가 이미 접어서 주지만, 여기서 한 사람이
  // 두 줄이면 그 사람에게 메시지가 두 통 나간다 — 발송 경로에는 방어를 겹쳐 둔다.
  const seen = new Set<string>();
  const withItems = inWindow.filter((s) => {
    if (s.items.length === 0 || seen.has(s.lineUserId)) return false;
    seen.add(s.lineUserId);
    return true;
  });
  const boughtOf = (s: CartSnapshot) => {
    const gid = gidByLine.get(s.lineUserId);
    return !!gid && buyers.has(gid);
  };

  return {
    inWindow: inWindow.length,
    emptied: inWindow.filter((s) => s.items.length === 0).length,
    reachedCheckout: withItems.filter((s) => checkoutReached.has(s.lineUserId)).length,
    bought: withItems.filter(boughtOf).length,
    alreadySent: withItems.filter((s) => handled.has(cartKey(s.lineUserId, s.items))).length,
    fresh: withItems.filter(
      (s) =>
        !checkoutReached.has(s.lineUserId) &&
        !boughtOf(s) &&
        !handled.has(cartKey(s.lineUserId, s.items)),
    ),
  };
}

async function runCartAdd(
  now: number,
  dryRun: boolean,
  /** 결제창까지 간 사람 — 저니 1 의 몫이라 여기서 뺀다 */
  checkoutReached: Set<string>,
  members: Member[],
  buyers: Set<string>,
): Promise<RunResult> {
  const [snapshots, handled] = await Promise.all([
    fetchCartSnapshots(now),
    alreadyHandled(CART_ADD),
  ]);

  const gidByLine = new Map<string, string>();
  for (const m of members) if (m.lineUserId) gidByLine.set(m.lineUserId, m.gid);

  const { inWindow, emptied, reachedCheckout, bought, alreadySent, fresh } = selectCartAddTargets({
    snapshots,
    now,
    checkoutReached,
    buyers,
    gidByLine,
    handled,
  });

  const cap = await applyFrequencyCap(
    fresh.map((s) => s.lineUserId),
    now,
  );
  const allowed = new Set(cap.allowed);
  const targets = fresh.filter((s) => allowed.has(s.lineUserId)).slice(0, MAX_PER_RUN);

  const base: RunResult = {
    journey: CART_ADD,
    found: inWindow.length,
    willSend: targets.length,
    sent: 0,
    notFriend: 0,
    failed: 0,
    capped: cap.capped.length,
    excluded: {
      카트비움: emptied,
      결제창까지감: reachedCheckout,
      구매함: bought,
      이미발송: alreadySent,
      수신한도: cap.capped.length,
    },
    samples: targets.slice(0, 2).map((s) => ({
      text: buildCartAddMessage(s.items, cartRestoreUrl(s.items)),
      note: `담기 ${new Date(s.at).toISOString()} · ${s.items.length}줄`,
    })),
  };
  if (dryRun) return base;

  const delivered: { userId: string; ref: string }[] = [];
  for (const s of targets) {
    const ref = cartKey(s.lineUserId, s.items);
    const result = await pushLine(s.lineUserId, buildCartAddMessage(s.items, cartRestoreUrl(s.items)));
    if (result === 'sent') {
      base.sent++;
      delivered.push({ userId: s.lineUserId, ref });
    } else if (result === 'not-friend') {
      base.notFriend++;
      delivered.push({ userId: s.lineUserId, ref });
    } else {
      base.failed++;
    }
  }

  for (const d of delivered) {
    await recordSends([d.userId], {
      campaignId: `journey_${CART_ADD}`,
      journey: CART_ADD,
      kind: 'marketing',
      ref: d.ref,
      name: '장바구니 담기 이탈',
      // 🔴 클릭 추적(`/api/line-click`)을 쓰지 않는다.
      //
      //    복구 저니가 그걸 쓰는 이유는 Shopify 복구 URL 이 우리 프론트를 거치지 않아
      //    주문에 UTM 이 안 붙기 때문이다. 담기 저니의 링크는 **우리 사이트**라
      //    `index.html` 이 UTM 을 sessionStorage 에 담고 체크아웃이 주문 속성으로 실어
      //    보낸다 — UTM 쪽이 더 정확하다.
      //
      //    게다가 클릭 래퍼를 씌우면 조용히 깨진다: 서명 토큰은 `<url>|<ref>` 를 마지막
      //    `|` 로 가르는데 여기 ref(`userId|변형x수량`)에 `|` 가 들어 있어 목적지와 ref 가
      //    둘 다 잘린다. 그리고 `clickTracked` 를 켜면 성과 집계가 UTM 분기를 아예 건너뛴다.
      utm: CART_ADD_UTM,
    });
  }
  return base;
}

/**
 * 저니 3 — 연결 다음날 첫 구매 유도.
 *
 * 문안은 2026-08-21 테스트 발송으로 확인한 것을 그대로 쓴다.
 * ⚠️ 「初回」라고 단정하지 않는다. 예전에 게스트로 산 사람이 섞일 수 있는데 그 이력은
 *    LINE 으로 만든 고객 레코드에 안 붙어 있어 우리가 알 방법이 없다. 「まだお使いでない方に」와
 *    「お一人さま1回限り」로 조건을 문장 안에 넣어, 이미 쓴 사람이 받아도 거짓이 되지 않게 한다.
 */
const FIRST_PURCHASE_TEXT = [
  'こんにちは、BITE ME JAPANです🐾',
  '',
  'ご登録ありがとうございます！',
  'まだクーポンをお使いでない方に',
  '10%OFFをご用意しています🎁',
  '',
  '下のリンクからお進みいただくと',
  'お会計時に自動で入ります。',
  '（お一人さま1回限り）',
  '',
  'いま人気のアイテムを見る👇',
  FIRST_PURCHASE_URL,
].join('\n');

async function runFirstPurchase(now: number, dryRun: boolean, members: Member[]): Promise<RunResult> {
  const handled = await alreadyHandled(FIRST_PURCHASE);

  const inWindow = members.filter((m) => {
    const ageH = (now - new Date(m.createdAt).getTime()) / 3600_000;
    return ageH >= FIRST_PURCHASE_MIN_H && ageH < FIRST_PURCHASE_MAX_H;
  });
  const eligible = inWindow.filter((m) => m.orders === 0 && !!m.lineUserId && !handled.has(m.gid));

  const cap = await applyFrequencyCap(
    eligible.map((m) => m.lineUserId as string),
    now,
  );
  const allowed = new Set(cap.allowed);
  const targets = eligible.filter((m) => allowed.has(m.lineUserId as string)).slice(0, MAX_PER_RUN);

  const base: RunResult = {
    journey: FIRST_PURCHASE,
    found: inWindow.length,
    willSend: targets.length,
    sent: 0,
    notFriend: 0,
    failed: 0,
    capped: cap.capped.length,
    excluded: {
      구매함: inWindow.filter((m) => m.orders > 0).length,
      발송불가: inWindow.filter((m) => !m.lineUserId).length,
      이미발송: inWindow.filter((m) => handled.has(m.gid)).length,
      수신한도: cap.capped.length,
    },
    samples: targets.length > 0 ? [{ text: FIRST_PURCHASE_TEXT }] : [],
  };
  if (dryRun) return base;

  const delivered: { userId: string; ref: string }[] = [];
  for (const m of targets) {
    const result = await pushLine(m.lineUserId as string, FIRST_PURCHASE_TEXT);
    if (result === 'sent') {
      base.sent++;
      delivered.push({ userId: m.lineUserId as string, ref: m.gid });
    } else if (result === 'not-friend') {
      base.notFriend++;
      delivered.push({ userId: m.lineUserId as string, ref: m.gid });
    } else {
      base.failed++;
    }
  }

  for (const d of delivered) {
    await recordSends([d.userId], {
      campaignId: `journey_${FIRST_PURCHASE}`,
      journey: FIRST_PURCHASE,
      kind: 'marketing',
      ref: d.ref,
      name: '연결 직후 첫 구매 유도',
      utm: FIRST_PURCHASE_UTM,
    });
  }
  return base;
}

/** `LINE_JOURNEY_ENABLED` 에 적힌 저니만 돈다. `all` 이면 전부. 값이 없으면 아무것도 안 보낸다. */
function enabledJourneys(): string[] {
  const raw = (process.env.LINE_JOURNEY_ENABLED ?? '').trim();
  if (!raw) return [];
  if (raw === 'all') return [...JOURNEY_ORDER];
  const set = new Set(raw.split(',').map((v) => v.trim()));
  return JOURNEY_ORDER.filter((j) => set.has(j));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const now = Date.now();
  const enabled = enabledJourneys();

  try {
    if (!dryRun && enabled.length === 0) {
      return res.status(200).json({ ok: true, skipped: 'LINE_JOURNEY_ENABLED 미설정' });
    }

    if (!dryRun && inQuietHours(new Date(now))) {
      // 버리지 않는다. 창이 열리는 다음 실행에서 같은 사람이 다시 잡힌다.
      return res.status(200).json({ ok: true, skipped: '조용한 시간 (JST 21~09시)' });
    }

    // 🔴 중복 방지와 빈도 제한이 전부 이 기록 위에 선다. 기록이 없으면 매시간 같은 사람에게
    //    다시 보낸다 — 발송을 멈추는 쪽이 맞다.
    if (!dryRun && !supabase()) {
      console.error('[LINE Journey] 🔴 SUPABASE 미설정 — 중복 방지가 불가능해 발송을 중단합니다');
      return res.status(500).json({ error: '발송 기록 저장소가 없어 중단했습니다' });
    }

    const token = await getAdminToken();
    const runs = (j: (typeof JOURNEY_ORDER)[number]) => dryRun || enabled.includes(j);
    const needsCarts = runs(CART_RECOVERY) || runs(CART_ADD);

    // 공용 조회는 여기서 한 번만 한다. 저니마다 부르면 한 번 실행에 고객 목록을 두 번,
    // 최근 주문을 두 번 훑어서 함수 시간을 다 쓴다 — 발송 도중에 타임아웃이 나면
    // 중복 방지 기록(recordSends)이 안 남아 다음 시간에 같은 사람에게 또 나간다.
    const [members, buyers] = await Promise.all([
      runs(CART_ADD) || runs(FIRST_PURCHASE) ? fetchAudience() : Promise.resolve([] as Member[]),
      needsCarts ? fetchRecentBuyers(token, now) : Promise.resolve(new Set<string>()),
    ]);

    // 결제창 이탈은 한 번만 읽어 두 저니가 나눠 쓴다 (저니 1 = 대상, 저니 2 = 제외 조건).
    // 🔴 여기서 던지면 안 된다. 이 조회가 실패했다고 관계없는 첫 구매 유도까지 멈추면
    //    Shopify 딸꾹질 한 번에 그날 발송이 통째로 사라진다. 실패는 두 카트 저니만 건너뛴다.
    let abandoned: Candidate[] | null = null;
    if (needsCarts) {
      abandoned = await fetchCandidates(token, now).catch((e: unknown) => {
        console.error('[LINE Journey] 🔴 이탈 조회 실패 — 카트 저니만 건너뜁니다:', e);
        return null;
      });
    }
    const checkoutReached = new Set((abandoned ?? []).map((c) => c.lineUserId));
    const results: RunResult[] = [];

    // ⚠️ 순서대로 돈다. 빈도 제한이 하루 1통이라 앞 저니가 보낸 사람은 뒤 저니에서 빠진다.
    //    즉 이 배열의 순서가 곧 우선순위다.
    for (const j of JOURNEY_ORDER) {
      // 드라이런은 꺼져 있어도 "켜면 어떻게 되는지"를 보여줘야 하므로 전부 돈다
      if (!runs(j)) continue;
      // 이탈 조회가 실패한 실행에서는 카트 두 저니를 건너뛴다 (없는 데이터로 판정하지 않는다)
      if ((j === CART_RECOVERY || j === CART_ADD) && abandoned === null) continue;
      if (j === CART_RECOVERY) results.push(await runCartRecovery(token, now, dryRun, abandoned!, buyers));
      if (j === CART_ADD) results.push(await runCartAdd(now, dryRun, checkoutReached, members, buyers));
      if (j === FIRST_PURCHASE) results.push(await runFirstPurchase(now, dryRun, members));
    }

    if (!dryRun) {
      for (const r of results) {
        console.log(
          `[LINE Journey] ${r.journey} 발송 ${r.sent}건 · 친구아님 ${r.notFriend} · 실패 ${r.failed}`,
        );
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      enabled,
      quietHours: inQuietHours(new Date(now)),
      journeys: results,
      willSend: results.reduce((s, r) => s + r.willSend, 0),
      sent: results.reduce((s, r) => s + r.sent, 0),
    });
  } catch (error) {
    console.error('[LINE Journey] Error:', error);
    return res
      .status(500)
      .json({ error: error instanceof Error ? error.message : '저니 실행 중 오류가 발생했습니다' });
  }
}

