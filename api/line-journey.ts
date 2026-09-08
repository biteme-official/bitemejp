/**
 * /api/line-journey — 트리거로 도는 LINE 자동 발송
 *
 * 저니 세 갈래가 우선순위 순으로 돈다.
 *   1. cart_recovery      장바구니 이탈 복구 — 결제창까지 갔다가 이탈 (신호가 가장 강하다).
 *   2. cart_add           장바구니 담기 이탈 — 담기만 하고 결제창에 안 간 사람.
 *                         Shopify 는 결제창 이탈만 기록해서 여기가 통째로 사각지대였다.
 *                         2026-09-04 담기 이벤트 때 담기 293→1,341 인데 결제창 이탈은 15→16.
 *                         카트 스냅샷은 `/api/line-cart` 가 남긴다.
 *   3. repeat_purchase_d21 재구매 유도 — 마지막 주문 3주 뒤. 산 사람은 그동안 아무도
 *                         말을 걸지 않던 구간이었다. 2026-09-08 실측: LINE 연결 구매자
 *                         260명 중 252명(97%)이 1회 구매뿐이고, 전체 재구매 간격 중앙값은 20일.
 *   4. first_purchase_d1  연결 다음날 첫 구매 유도 — 볼륨이 가장 크다(월 약 300통).
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
const REPEAT_PURCHASE = 'repeat_purchase_d21';
const FIRST_PURCHASE = 'first_purchase_d1';

/**
 * 순서 = 우선순위. 앞에 있는 저니가 먼저 대상을 가져간다.
 *
 * **실측 회수율 순**이다(2026-09-08): 복구 28.3% · 첫 구매 2.5%. 담기와 재구매는 아직
 * 표본이 모자라 신호 세기(카트에 담았다 > 3주 전에 샀다)로 그 사이에 둔다.
 * 숫자가 쌓이면 이 줄을 다시 볼 것 — 순서를 정하는 건 모수가 아니라 회수율이다.
 */
const JOURNEY_ORDER = [CART_RECOVERY, CART_ADD, REPEAT_PURCHASE, FIRST_PURCHASE] as const;

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
 * 재구매를 권하는 시점 — **마지막** 주문으로부터 21~22일.
 *
 * 창을 딱 하루로 잡는 이유가 두 가지다.
 *
 * 1. 🔴 **최초 가동 때 옛날 사람이 쏟아지지 않는다.** 창을 「14~35일」처럼 넓게 잡으면
 *    켜는 순간 그 구간에 이미 들어와 있는 사람 전원에게 한꺼번에 나간다. 하루짜리 창은
 *    오늘 D+21 이 된 사람만 잡으므로 켠 날부터 자연스러운 흐름으로만 나간다.
 * 2. 한 사람이 이 창을 통과하는 건 주문 한 건당 딱 한 번이다. 중복 방지(ref = 주문 id)와
 *    맞물려 「주문 한 건에 재구매 권유 한 통」이 된다.
 *
 * 21일은 2026-09-08 실측에서 나온 값이다 — 전체 재구매 간격 중앙값 20일(p25 7 · p75 35).
 * 중앙값 언저리에 서면 「이미 다시 산 사람」은 마지막 주문이 갱신돼 저절로 빠지고,
 * 아직 안 산 사람만 남는다.
 */
const REPEAT_MIN_H = 21 * 24;
const REPEAT_MAX_H = 22 * 24;

/** 재구매 저니가 훑는 주문 범위. 창보다 하루 넉넉히 봐야 「그 뒤에 또 샀는가」를 판정할 수 있다. */
const REPEAT_LOOKBACK_DAYS = 23;

const REPEAT_UTM = 'line_repeat_d21';
const REPEAT_URL = `https://biteme.co.jp/?utm_source=line&utm_medium=line&utm_campaign=${REPEAT_UTM}`;

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
          lineItems: {
            edges: {
              node: {
                title: string;
                quantity: number;
                originalUnitPriceSet: { shopMoney: { amount: string } } | null;
              };
            }[];
          };
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
            lineItems(first: 5) { edges { node {
              title
              quantity
              originalUnitPriceSet { shopMoney { amount } }
            } } }
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

      // 증정품(정가 0)은 빼고 고른다. 카트 스냅샷(`cartSync`)은 클라이언트에서 이미
      // 걸러 보내지만, 이탈 결제는 Shopify 가 준 그대로라 증정 줄이 **맨 앞에** 올 수 있다.
      // 그러면 "「BITE ME サマーうちわ」를 お取り置き하고 있습니다" 가 되어, 우리가 끼워 준
      // 물건을 미끼로 쓰는 문장이 된다.
      const items = (n.lineItems?.edges ?? []).filter(
        (e) => Number(e.node.originalUnitPriceSet?.shopMoney?.amount ?? 0) > 0,
      );
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
  /**
   * 저니가 읽어 온 원재료의 크기. 발송 창 밖까지 포함한다.
   *
   * `found` 는 창 안에 든 것만 세기 때문에, 0 이어도 "아직 아무도 조건을 안 채웠다"인지
   * "애초에 데이터가 안 들어오고 있다"인지 구분이 안 된다. 담기 저니는 수집을 새로 붙인
   * 저니라 이 구분이 특히 중요해서, 창 밖 것까지 센 수를 따로 남긴다.
   */
  pool?: number;
  found: number;
  willSend: number;
  sent: number;
  notFriend: number;
  failed: number;
  capped: number;
  excluded: Record<string, number>;
  samples: { text: string; note?: string }[];
}

/**
 * 저니마다 「이번 실행에 누구에게 무엇을 보낼 것인가」만 만들어 두는 단계.
 *
 * 발송을 여기서 하지 않는 이유는 **실행 순서를 모수 크기로 정하기 때문**이다.
 * 순서를 알려면 세 저니의 후보를 먼저 다 세어 봐야 하고, 세기 전에 하나라도 보내 버리면
 * 빈도 제한이 이미 깎여서 나머지의 모수가 실제보다 작게 잡힌다.
 */
interface JourneyPlan {
  journey: string;
  /** 읽어 온 원재료 (창 밖 포함). 수집 자체가 도는지 보는 값 */
  pool?: number;
  /** 창 안에 들어온 전체 (제외 조건 적용 전) */
  found: number;
  excluded: Record<string, number>;
  /** 제외 조건을 모두 통과한 사람. **이 수가 모수이고 실행 순서를 정한다.** */
  candidates: { userId: string; ref: string; text: string; note?: string }[];
  record: { campaignId: string; name: string; utm: string | null; clickTracked?: boolean };
}

/** 저니 1 — 장바구니 이탈 복구 */
async function planCartRecovery(
  now: number,
  abandoned: Candidate[],
  buyers: Set<string>,
): Promise<JourneyPlan> {
  const handled = await alreadyHandled(CART_RECOVERY);

  const candidates = abandoned.filter((c) => c.ageH >= MIN_AGE_HOURS && c.ageH <= MAX_AGE_HOURS);
  const fresh = candidates.filter((c) => !buyers.has(c.customerGid) && !handled.has(c.checkoutId));

  // 같은 사람이 여러 번 이탈했으면 가장 최근 것 하나만
  const perUser = new Map<string, Candidate>();
  for (const c of fresh) {
    const prev = perUser.get(c.lineUserId);
    if (!prev || new Date(c.createdAt) > new Date(prev.createdAt)) perUser.set(c.lineUserId, c);
  }

  return {
    journey: CART_RECOVERY,
    found: candidates.length,
    excluded: {
      구매함: candidates.filter((c) => buyers.has(c.customerGid)).length,
      이미발송: candidates.filter((c) => handled.has(c.checkoutId)).length,
    },
    // 실제로 나갈 링크(추적 링크) 그대로 만든다 — 문안 확인이 링크 확인을 겸해야 한다
    candidates: [...perUser.values()].map((c) => ({
      userId: c.lineUserId,
      ref: c.checkoutId,
      text: buildMessage(c, trackedUrl(c.recoveryUrl, c.checkoutId)),
      note: `이탈 ${c.createdAt}`,
    })),
    record: {
      campaignId: `journey_${CART_RECOVERY}`,
      name: '장바구니 이탈 복구',
      // 복구 링크는 Shopify 도메인이라 UTM 을 붙여도 우리 프론트를 거치지 않는다.
      // 그래서 이 저니의 하한은 UTM 이 아니라 **클릭**으로 센다 (`/api/line-click`).
      utm: null,
      clickTracked: true,
    },
  };
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

/**
 * 담기 이탈 복구 링크 — 우리 사이트에서 카트를 그대로 되살린다(로그인·쿠폰 상태 유지).
 *
 * LINE 은 링크를 그냥 글자로 보여준다. 길면 휴대폰에서 서너 줄을 잡아먹고 그것만으로
 * 광고처럼 보인다. 그래서 짧게 만든다 — 158자에서 46자로.
 *
 *   https://biteme.co.jp/r/ifyim7e49~1.ifyisg4zd~2
 *
 * 줄인 방법 세 가지. **조회 테이블을 쓰지 않는다** — 코드→주소 매핑을 두면 그 조회가
 * 고객이 자기 카트로 가는 길 위에 새 실패 지점이 된다. 지표 하나 때문에 복구 링크를
 * 못 열게 만드는 것이 훨씬 큰 손해라는 `line-click.ts` 의 원칙과 같다.
 *
 *   1. 상품 id 를 뺀다 — 옵션(variant) id 하나로 상품까지 찾을 수 있다
 *   2. 남은 숫자를 36진수로 (14자리 → 9자)
 *   3. UTM 을 주소에서 뺀다 — `/r/` 로 들어오는 길은 이 저니뿐이라 `index.html` 이 심는다
 */
export function cartRestoreUrl(items: CartLine[]): string {
  const c = items
    .map((i) => `${BigInt(i.variantId.split('/').pop() ?? '0').toString(36)}~${i.quantity}`)
    .join('.');
  // `~` 와 `.` 는 경로에 그대로 쓸 수 있는 문자다(RFC 3986 unreserved / sub-delims).
  // 인코딩되지 않으므로 %7E 같은 것이 끼어 링크가 다시 길어지지 않는다.
  return `https://biteme.co.jp/r/${c}`;
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
    // 🔴 「ご注文手続きはまだ完了していません」라고 쓰지 않는다. 이 저니는 결제창까지
    //    간 사람을 조건에서 빼기 때문에, 받는 사람은 주문 절차를 시작한 적이 **없다**.
    //    (그 문장은 결제창 이탈 복구 저니의 것이다.)
    '下のリンクから、そのまま',
    'ご購入手続きに進めます。',
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

async function planCartAdd(
  now: number,
  /** 결제창까지 간 사람 — 저니 1 의 몫이라 여기서 뺀다 */
  checkoutReached: Set<string>,
  members: Member[],
  buyers: Set<string>,
): Promise<JourneyPlan> {
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

  return {
    journey: CART_ADD,
    // 창(3~20h) 밖까지 포함한 스냅샷 수. 이 값이 0 이면 창 문제가 아니라
    // **수집이 아예 안 들어오고 있는 것**이다.
    pool: snapshots.length,
    found: inWindow,
    excluded: {
      카트비움: emptied,
      결제창까지감: reachedCheckout,
      구매함: bought,
      이미발송: alreadySent,
    },
    candidates: fresh.map((s) => ({
      userId: s.lineUserId,
      ref: cartKey(s.lineUserId, s.items),
      text: buildCartAddMessage(s.items, cartRestoreUrl(s.items)),
      note: `담기 ${new Date(s.at).toISOString()} · ${s.items.length}줄`,
    })),
    record: {
      campaignId: `journey_${CART_ADD}`,
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
    },
  };
}

/* ─── 저니 3 — 재구매 유도 ────────────────────────────────────────────────────
 *
 * 앞의 두 저니와 방향이 반대다. 저 둘은 「아직 안 산 사람」을 쫓고, 이건 **산 사람**을 본다.
 * 지금까지 구매 이후 구간에는 배송 알림 말고 아무것도 없었다.
 */

/** 사람마다 마지막 주문 하나. 「그 뒤에 또 샀는가」는 이 값이 갱신되는 것으로 판정된다. */
interface LastOrder {
  customerGid: string;
  orderGid: string;
  at: number;
  itemTitle: string | null;
  itemCount: number;
}

/**
 * 최근 주문을 훑어 사람마다 마지막 것 하나만 남긴다.
 *
 * 🔴 「D+21 인 주문」을 바로 찾지 않고 **마지막 주문**을 고르는 게 핵심이다. 주문 단위로
 *    보면 3주 전에 사고 지난주에 또 산 사람에게 "그동안 어떠셨나요"가 나간다.
 */
async function fetchLastOrders(token: string, now: number): Promise<LastOrder[]> {
  const since = new Date(now - REPEAT_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const latest = new Map<string, LastOrder>();
  let cursor: string | null = null;

  for (;;) {
    const res = await adminGraphQL<{
      data?: {
        orders?: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: {
            node: {
              id: string;
              createdAt: string;
              customer: { id: string } | null;
              lineItems: {
                edges: {
                  node: {
                    title: string;
                    quantity: number;
                    originalUnitPriceSet: { shopMoney: { amount: string } } | null;
                  };
                }[];
              };
            };
          }[];
        };
      };
      errors?: unknown;
    }>(
      token,
      `query RepeatOrders($cursor: String, $q: String) {
        orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id
            createdAt
            customer { id }
            lineItems(first: 5) { edges { node {
              title
              quantity
              originalUnitPriceSet { shopMoney { amount } }
            } } }
          } }
        }
      }`,
      { cursor, q: `created_at:>=${since}` },
    );

    const conn = res?.data?.orders;
    if (!conn) throw new Error(`주문 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 300)}`);

    for (const e of conn.edges) {
      const n = e.node;
      if (!n.customer) continue;
      const at = new Date(n.createdAt).getTime();
      const prev = latest.get(n.customer.id);
      if (prev && prev.at >= at) continue;
      // 🔴 증정품을 빼고 고른다. 사은품(うちわ 등)이 줄의 **맨 앞**에 오는 주문이 있어서,
      //    그냥 첫 줄을 집으면 "「BITE ME サマーうちわ」는 어떠셨나요" 가 나간다 —
      //    돈 주고 산 물건이 아니라 우리가 끼워 준 물건의 감상을 묻는 꼴이 된다.
      //    증정품은 정가가 0 이라 그것으로 가른다.
      const items = (n.lineItems?.edges ?? []).filter(
        (i) => Number(i.node.originalUnitPriceSet?.shopMoney?.amount ?? 0) > 0,
      );
      latest.set(n.customer.id, {
        customerGid: n.customer.id,
        orderGid: n.id,
        at,
        itemTitle: items[0]?.node?.title ?? null,
        itemCount: items.reduce((sum, i) => sum + (i.node.quantity ?? 1), 0),
      });
    }

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return [...latest.values()];
}

/**
 * 문안.
 *
 * 🔴 쿠폰을 붙이지 않는다. 이탈 저니와 같은 이유이지만 여기가 더 위험하다 —
 *    "3주 기다리면 할인이 온다"를 **만족한 고객에게** 학습시키는 게 되기 때문이다.
 *    링크는 상품 페이지가 아니라 몰 첫 화면이다. 산 물건이 소모품인지 아닌지
 *    (사료냐 리드줄이냐) 우리가 모르는 채로 같은 걸 또 권하면 어긋난다.
 *    무엇을 샀는지는 문장으로만 부른다 — 그 한 줄이 이 메시지를 「나에게 온 것」으로 만든다.
 */
export function buildRepeatMessage(itemTitle: string | null, itemCount: number, url: string): string {
  const first = stripControl(itemTitle ?? '').trim();
  // 「ほかN点」의 기준은 앞선 두 저니와 같다 — 줄 수가 아니라 총 수량 − 1.
  const rest = itemCount - 1;
  const what = first
    ? `「${first}」${rest > 0 ? ` ほか${rest}点` : ''}`
    : 'お求めいただいた商品';

  return [
    'その後、いかがでしょうか🐾',
    '',
    'BITE ME JAPANです。',
    `${what}は`,
    'お役に立っていますか？',
    '',
    '新しく入荷したアイテムも',
    'ぜひご覧ください。',
    '',
    '▼ ショップを見る',
    url,
  ].join('\n');
}

async function planRepeatPurchase(
  now: number,
  members: Member[],
  token: string,
): Promise<JourneyPlan> {
  const [lastOrders, handled] = await Promise.all([
    fetchLastOrders(token, now),
    alreadyHandled(REPEAT_PURCHASE),
  ]);

  const lineByGid = new Map<string, string>();
  for (const m of members) if (m.lineUserId) lineByGid.set(m.gid, m.lineUserId);

  const inWindow = lastOrders.filter((o) => {
    const ageH = (now - o.at) / 3600_000;
    return ageH >= REPEAT_MIN_H && ageH < REPEAT_MAX_H;
  });

  const fresh = inWindow.filter((o) => lineByGid.has(o.customerGid) && !handled.has(o.orderGid));

  return {
    journey: REPEAT_PURCHASE,
    // 창 밖까지 포함해 읽어 온 고객 수. 0 이면 창 문제가 아니라 주문 조회가 죽은 것이다.
    pool: lastOrders.length,
    found: inWindow.length,
    excluded: {
      // 구매 고객의 대부분은 LINE 을 안 쓴다. 이 값이 크다고 이상한 게 아니다 —
      // 2026-09-08 기준 구매 고객 2,234명 중 LINE 연결은 260명(11.6%)이다.
      라인미연결: inWindow.filter((o) => !lineByGid.has(o.customerGid)).length,
      이미발송: inWindow.filter((o) => handled.has(o.orderGid)).length,
    },
    candidates: fresh.map((o) => ({
      userId: lineByGid.get(o.customerGid) as string,
      // 주문 id 로 막는다. 사람으로 막으면 다음 주문 뒤에는 영영 못 보낸다.
      ref: o.orderGid,
      text: buildRepeatMessage(o.itemTitle, o.itemCount, REPEAT_URL),
      note: `마지막 주문 ${new Date(o.at).toISOString()}`,
    })),
    record: {
      campaignId: `journey_${REPEAT_PURCHASE}`,
      name: '재구매 유도',
      // 링크가 우리 사이트라 `index.html` 이 UTM 을 실어 체크아웃까지 넘긴다.
      utm: REPEAT_UTM,
    },
  };
}

/**
 * 저니 4 — 연결 다음날 첫 구매 유도.
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

async function planFirstPurchase(now: number, members: Member[]): Promise<JourneyPlan> {
  const handled = await alreadyHandled(FIRST_PURCHASE);

  const inWindow = members.filter((m) => {
    const ageH = (now - new Date(m.createdAt).getTime()) / 3600_000;
    return ageH >= FIRST_PURCHASE_MIN_H && ageH < FIRST_PURCHASE_MAX_H;
  });
  const eligible = inWindow.filter((m) => m.orders === 0 && !!m.lineUserId && !handled.has(m.gid));

  return {
    journey: FIRST_PURCHASE,
    found: inWindow.length,
    excluded: {
      구매함: inWindow.filter((m) => m.orders > 0).length,
      발송불가: inWindow.filter((m) => !m.lineUserId).length,
      이미발송: inWindow.filter((m) => handled.has(m.gid)).length,
    },
    candidates: eligible.map((m) => ({
      userId: m.lineUserId as string,
      ref: m.gid,
      text: FIRST_PURCHASE_TEXT,
    })),
    record: {
      campaignId: `journey_${FIRST_PURCHASE}`,
      name: '연결 직후 첫 구매 유도',
      utm: FIRST_PURCHASE_UTM,
    },
  };
}

/**
 * 계획 하나를 실제로 내보낸다.
 *
 * 빈도 제한은 **여기서** 건다. 계획 단계가 아니라 발송 직전에 걸어야, 같은 실행에서
 * 앞서 나간 저니가 이미 쓴 사람을 정확히 뺄 수 있다(기록이 `events` 에 남고 그걸 다시 읽는다).
 */
async function deliver(plan: JourneyPlan, now: number, dryRun: boolean): Promise<RunResult> {
  const byUser = new Map(plan.candidates.map((c) => [c.userId, c]));
  const cap = await applyFrequencyCap([...byUser.keys()], now);
  const targets = cap.allowed.map((id) => byUser.get(id)!).slice(0, MAX_PER_RUN);

  const base: RunResult = {
    journey: plan.journey,
    ...(plan.pool === undefined ? {} : { pool: plan.pool }),
    found: plan.found,
    willSend: targets.length,
    sent: 0,
    notFriend: 0,
    failed: 0,
    capped: cap.capped.length,
    excluded: { ...plan.excluded, 수신한도: cap.capped.length },
    // userId 는 싣지 않는다. 문안은 실제로 나갈 것 그대로 보여준다.
    samples: targets.slice(0, 2).map((c) => ({ text: c.text, note: c.note })),
  };
  if (dryRun) return base;

  const delivered: { userId: string; ref: string }[] = [];
  for (const c of targets) {
    // 직렬로 보낸다. 병렬은 레이트리밋에 걸리고 어디까지 나갔는지도 흐려진다.
    const result = await pushLine(c.userId, c.text);
    if (result === 'sent') {
      base.sent++;
      delivered.push({ userId: c.userId, ref: c.ref });
    } else if (result === 'not-friend') {
      base.notFriend++;
      // 친구가 아니면 다시 시도해도 같은 결과다. 재시도하지 않도록 기록은 남긴다.
      delivered.push({ userId: c.userId, ref: c.ref });
    } else {
      base.failed++;
    }
  }

  for (const d of delivered) {
    await recordSends([d.userId], {
      campaignId: plan.record.campaignId,
      journey: plan.journey,
      kind: 'marketing',
      ref: d.ref,
      name: plan.record.name,
      utm: plan.record.utm,
      ...(plan.record.clickTracked ? { clickTracked: true } : {}),
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

/**
 * `JOURNEY_ORDER` 순서 — **잘 먹히는 저니부터**. 제자리 정렬이다.
 *
 * 빈도 제한 때문에 앞선 저니가 겹치는 사람을 가져가므로, 이 정렬이 곧 "누가 어떤 메시지를
 * 받는가"를 정한다.
 *
 * 🔴 예전에는 **모수가 큰 저니부터** 돌렸다. 어느 저니가 큰지는 날마다 바뀌니 고정 순서보다
 *    낫다는 논리였는데, 실측이 정반대를 가리켰다 (2026-09-08):
 *
 *      장바구니 이탈 복구   회수율 28.3%  후보 2건   → 모수순에서는 항상 꼴찌
 *      연결 다음날 첫 구매   회수율  2.5%  후보 128건 → 모수순에서는 항상 1등
 *
 *    11배 잘 먹히는 저니가 순서에서 지고 있었다. 겹치는 사람이 생기는 날마다 회수율 28% 짜리
 *    한 통이 2.5% 짜리 한 통에 밀려 사라진다. 모수는 "몇 명에게 보낼 수 있나"이지
 *    "보내면 몇 명이 사나"가 아니다 — 한 사람을 두고 다투는 자리에서는 뒤쪽이 기준이다.
 */
export function sortByPriority(plans: { journey: string }[]): void {
  const rank = (j: string) => {
    const i = JOURNEY_ORDER.indexOf(j as (typeof JOURNEY_ORDER)[number]);
    return i === -1 ? JOURNEY_ORDER.length : i;
  };
  plans.sort((a, b) => rank(a.journey) - rank(b.journey));
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
      runs(CART_ADD) || runs(REPEAT_PURCHASE) || runs(FIRST_PURCHASE)
        ? fetchAudience()
        : Promise.resolve([] as Member[]),
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

    // ── 실행 순서 ────────────────────────────────────────────────────────────
    // 빈도 제한이 하루 1통이라 **먼저 도는 저니가 대상을 가져가고, 진 쪽은 그냥 사라진다.**
    // 그래서 순서가 곧 우선순위이고, 순서는 실측 회수율 순(`JOURNEY_ORDER`)으로 고정한다.
    // 왜 모수순을 버렸는지는 `sortByPriority` 에 적어 뒀다.
    //
    // 🔴 저니의 후보를 **전부 세고 나서** 보내기 시작한다. 세기 전에 하나라도 보내면
    //    그 발송이 빈도 제한을 깎아서 나머지 저니의 모수가 실제보다 작게 잡힌다 —
    //    드라이런으로 보는 수와 실행이 보는 수가 어긋나고, `excluded` 집계도 흐려진다.
    const plans: JourneyPlan[] = [];
    for (const j of JOURNEY_ORDER) {
      // 드라이런은 꺼져 있어도 "켜면 어떻게 되는지"를 보여줘야 하므로 전부 돈다
      if (!runs(j)) continue;
      // 이탈 조회가 실패한 실행에서는 카트 두 저니를 건너뛴다 (없는 데이터로 판정하지 않는다)
      if ((j === CART_RECOVERY || j === CART_ADD) && abandoned === null) continue;
      if (j === CART_RECOVERY) plans.push(await planCartRecovery(now, abandoned!, buyers));
      if (j === CART_ADD) plans.push(await planCartAdd(now, checkoutReached, members, buyers));
      if (j === REPEAT_PURCHASE) plans.push(await planRepeatPurchase(now, members, token));
      if (j === FIRST_PURCHASE) plans.push(await planFirstPurchase(now, members));
    }

    sortByPriority(plans);

    for (const plan of plans) {
      results.push(await deliver(plan, now, dryRun));
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
      // 이번 실행의 순서와 그 근거(모수). 순서가 결과를 가르므로 응답에 남긴다.
      order: plans.map((p) => `${p.journey}:${p.candidates.length}`),
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

