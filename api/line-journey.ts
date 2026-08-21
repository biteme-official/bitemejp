/**
 * /api/line-journey — 트리거로 도는 LINE 자동 발송
 *
 * 저니 두 갈래가 우선순위 순으로 돈다.
 *   1. cart_recovery      장바구니 이탈 복구 — 최근 30일 연결 고객 이탈 120건 > 주문 103건.
 *                         결제창까지 온 사람이 산 사람보다 많아서 여기가 가장 크게 샌다.
 *   2. first_purchase_d1  연결 다음날 첫 구매 유도 — 볼륨이 가장 크다(월 약 300통).
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

const CART_RECOVERY = 'cart_recovery';
const FIRST_PURCHASE = 'first_purchase_d1';

/** 순서 = 우선순위. 앞에 있는 저니가 먼저 대상을 가져간다. */
const JOURNEY_ORDER = [CART_RECOVERY, FIRST_PURCHASE] as const;

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

/** 한 번 실행에 보낼 수 있는 최대 인원 — 폭주 방지 */
const MAX_PER_RUN = 100;

interface Candidate {
  checkoutId: string;
  createdAt: string;
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

async function fetchCandidates(token: string, now: number): Promise<Candidate[]> {
  const since = new Date(now - MAX_AGE_HOURS * 3600_000).toISOString().slice(0, 10);
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
      if (ageH < MIN_AGE_HOURS || ageH > MAX_AGE_HOURS) continue;
      if (!n.abandonedCheckoutUrl || !n.customer) continue;
      if (!(n.customer.tags ?? []).includes('line_member')) continue;

      const lineUserId = resolveLineUserId(n.customer);
      if (!lineUserId) continue;

      const items = n.lineItems?.edges ?? [];
      out.push({
        checkoutId: n.id,
        createdAt: n.createdAt,
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
function buildMessage(c: Candidate): string {
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
    c.recoveryUrl,
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

function authorized(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (process.env.ADMIN_SECRET && auth === `Bearer ${process.env.ADMIN_SECRET}`) return true;
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  // Vercel 크론은 인증 헤더 없이 이 헤더를 붙여 온다 (기존 크론과 같은 규칙)
  return !!req.headers['x-vercel-cron'];
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
async function runCartRecovery(token: string, now: number, dryRun: boolean): Promise<RunResult> {
  const [candidates, buyers, handled] = await Promise.all([
    fetchCandidates(token, now),
    fetchRecentBuyers(token, now),
    alreadyHandled(CART_RECOVERY),
  ]);

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
    samples: targets.slice(0, 2).map((c) => ({ text: buildMessage(c), note: `이탈 ${c.createdAt}` })),
  };
  if (dryRun) return base;

  const delivered: { userId: string; ref: string }[] = [];
  for (const c of targets) {
    // 직렬로 보낸다. 병렬은 레이트리밋에 걸리고 어디까지 나갔는지도 흐려진다.
    const result = await pushLine(c.lineUserId, buildMessage(c));
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
      // 이 저니의 기여는 시간 기준(회수)으로만 잡힌다.
      utm: null,
    });
  }
  return base;
}

/**
 * 저니 2 — 연결 다음날 첫 구매 유도.
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

async function runFirstPurchase(now: number, dryRun: boolean): Promise<RunResult> {
  const [members, handled] = await Promise.all([fetchAudience(), alreadyHandled(FIRST_PURCHASE)]);

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
    const results: RunResult[] = [];

    // ⚠️ 순서대로 돈다. 빈도 제한이 하루 1통이라 앞 저니가 보낸 사람은 뒤 저니에서 빠진다.
    //    즉 이 배열의 순서가 곧 우선순위다.
    for (const j of JOURNEY_ORDER) {
      // 드라이런은 꺼져 있어도 "켜면 어떻게 되는지"를 보여줘야 하므로 전부 돈다
      if (!dryRun && !enabled.includes(j)) continue;
      if (j === CART_RECOVERY) results.push(await runCartRecovery(token, now, dryRun));
      if (j === FIRST_PURCHASE) results.push(await runFirstPurchase(now, dryRun));
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
