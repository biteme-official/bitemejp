/**
 * /api/line-invite — LINE 친구지만 쇼핑몰과 연결 안 된 사람에게 연결 유도 메시지 (관리자 전용)
 *
 * 자동 메시지(장바구니·첫 구매·재구매)는 쇼핑몰과 연결된 친구에게만 갈 수 있다. 2026-10-15 실측
 * 친구 7,143명 중 연결 2,224명(31%) — 나머지는 누구인지 몰라 어떤 자동 메시지도 닿지 않는다.
 * 전체 발송한 날 신규 연결이 평소의 열 배 가까이 뛰는 것(8/25 136명, 9/3~5 사흘 394명)을 보고
 * 「연결하면 10%OFF」만 담은 발송을 연결 안 된 사람에게만 한 번 보낸다.
 *
 * 대상을 고르는 방법: 우리는 연결 안 된 친구의 LINE ID 를 모른다(친구추가를 기록하지 않는다).
 * 대신 **연결된 사람**의 ID 는 Shopify 에 있다. 그 목록을 LINE 오디언스로 올리고
 * narrowcast 를 「전체 친구 중 그 오디언스 제외」로 보낸다.
 *
 * ⚠️ 사람에게 메시지를 실제로 보낸다. 되돌릴 수 없다.
 *    - action `preview` — 문안·예상 대상 수·쿼터. 아무것도 보내지 않는다
 *    - action `send` + `testUserIds` — 그 사람들에게만 같은 문안 (눈으로 확인용)
 *    - action `send` + `confirm: true` — 실발송. 조용한 시간·30일 내 재발송·쿼터 부족이면 막는다
 *    - action `status` + `requestId` — narrowcast 는 비동기라 진행 상황을 따로 본다
 *
 * ⚠️ LINE userId 는 개인식별자다. 응답에 싣지 않는다.
 * ⚠️ narrowcast 는 받은 사람 목록을 돌려주지 않는다. 그래서 이 발송은 인당 수신 한도
 *    (`line_send`)에 기록되지 않는다 — 받는 사람이 애초에 저니 대상(연결된 사람)이 아니라서
 *    지금은 겹치지 않는다. 받고 바로 연결한 사람은 다음날 첫 구매 저니를 받을 수 있다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  CAMPAIGN_EVENT,
  buildMessage,
  fetchAudience,
  fetchQuota,
  inQuietHours,
  lineGet,
  lineToken,
  logCampaign,
  multicast,
  retryKey,
  supabase,
} from './line-campaign.js';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

/** 소재명. 캠페인 ID(`YYMMDD_link-invite`)·UTM(`YYMMDD_line_link-invite`)이 여기서 나온다 */
const CAMPAIGN_NAME = 'link-invite';

/** 로그인 입구. `line_src:invite` 태그로 이 발송이 만든 연결만 따로 센다 */
const INVITE_URL = 'https://biteme.co.jp/line-login?src=invite';

/** 같은 사람들에게 이 문안을 다시 보내기까지 기다리는 날수. 연결 유도를 매주 받으면 차단한다 */
const RESEND_GAP_DAYS = 30;

/** 오디언스 업로드 1회 최대 ID 수 (LINE 제한). 넘으면 추가 업로드가 필요하다 */
const AUDIENCE_UPLOAD_MAX = 10_000;

/** 오디언스가 READY 가 되기를 이 함수 안에서 기다리는 최대 시간 */
const AUDIENCE_WAIT_MS = 20_000;

/**
 * 문안.
 *
 * ⚠️ 쿠폰은 이 발송 전용 `LINKUP10`(연결 시 자동 예약, 1인 1회)이다. WELCOME10 을 이미 쓴
 *    사람에게도 한 번 더 주려고 코드를 나눴다(src/lib/lineWelcomeDiscount.ts). 그래서
 *    「まだクーポンをお使いでない方」 조건을 넣지 않는다.
 * 혜택은 하나만 건다. 세일·신상품을 섞으면 「연결」이라는 한 가지 행동이 흐려진다.
 */
const INVITE_TEXT = [
  'BITE ME JAPANです🐾',
  'いつもありがとうございます。',
  '',
  'LINEでログインするだけで',
  'ショップとLINEがつながり、',
  '次のお買い物が10%OFFになります🎁',
  '（お一人さま1回限り）',
  '',
  'つながると、こんなお知らせが届きます',
  '・カートに残した商品のお知らせ',
  '・再入荷のお知らせ',
  '・LINE会員限定のクーポン',
  '',
  '▼ LINEでログイン（1タップ）',
].join('\n');

function build() {
  return buildMessage({ name: CAMPAIGN_NAME, text: INVITE_TEXT, url: INVITE_URL });
}

/** 날짜가 하루 밀려 보이지 않게 JST 로 */
function yyyymmddJst(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

// ─── 대상 추정 ───────────────────────────────────────────────────────────────

interface Estimate {
  /** 인사이트 기준일 (3일 전, JST) */
  asOf: string;
  /** 친구추가 누적 — 차단한 사람도 들어 있다 */
  followers: number | null;
  blocks: number | null;
  /** 메시지가 닿는 친구 = 친구 − 차단 */
  reachable: number | null;
  /** 쇼핑몰과 연결되어 LINE ID 를 아는 사람 — 제외 목록 */
  linked: number;
  /** 예상 수신자 = 닿는 친구 − 연결. 연결된 사람 중 차단한 사람도 있어 실제는 이보다 조금 많다 */
  estimatedTargets: number | null;
}

async function estimate(linkedIds: string[]): Promise<Estimate> {
  // 인사이트는 2일 지연된다 — 3일 전 값을 쓴다
  const asOf = yyyymmddJst(new Date(Date.now() - 3 * 86_400_000));
  const f = await lineGet<{ status?: string; followers?: number; blocks?: number }>(
    `/v2/bot/insight/followers?date=${asOf}`,
  ).catch(() => null);
  const followers = f?.status === 'ready' && typeof f.followers === 'number' ? f.followers : null;
  const blocks = f?.status === 'ready' && typeof f.blocks === 'number' ? f.blocks : null;
  const reachable = followers !== null && blocks !== null ? followers - blocks : null;
  return {
    asOf,
    followers,
    blocks,
    reachable,
    linked: linkedIds.length,
    estimatedTargets: reachable === null ? null : Math.max(0, reachable - linkedIds.length),
  };
}

async function linkedLineIds(): Promise<string[]> {
  const members = await fetchAudience();
  return Array.from(new Set(members.map((m) => m.lineUserId).filter((id): id is string => !!id)));
}

// ─── 이전 발송 ───────────────────────────────────────────────────────────────

/** 최근 RESEND_GAP_DAYS 안에 실발송한 연결 유도가 있으면 그 시각. 테스트 발송은 세지 않는다 */
async function lastRealInvite(): Promise<string | null> {
  const db = supabase();
  if (!db) throw new Error('SUPABASE 미설정 — 이전 발송을 확인할 수 없어 보내지 않습니다');
  const since = new Date(Date.now() - RESEND_GAP_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from('events')
    .select('created_at, session_id')
    .eq('event_type', CAMPAIGN_EVENT)
    .like('session_id', `campaign:%_${CAMPAIGN_NAME}`)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  // 확인이 안 되면 보내지 않는다. 같은 4천 명에게 두 번 나가는 것이 하루 늦는 것보다 훨씬 나쁘다.
  if (error) throw new Error(`이전 발송 확인 실패: ${error.message}`);
  return (data ?? [])[0]?.created_at ?? null;
}

// ─── LINE 오디언스 ───────────────────────────────────────────────────────────

interface AudienceGroup {
  audienceGroupId: number;
  status: 'IN_PROGRESS' | 'READY' | 'FAILED' | 'EXPIRED' | 'INACTIVE' | 'ACTIVATING';
  audienceCount?: number;
  description: string;
}

/** 제외 목록 이름. 발송일마다 새로 만든다 — 연결된 사람은 매일 늘어서 지난 목록은 낡는다 */
function excludeDescription(campaignId: string): string {
  return `bitemejp exclude linked ${campaignId}`;
}

async function findAudience(description: string): Promise<AudienceGroup | null> {
  const res = await lineGet<{ audienceGroups?: AudienceGroup[] }>(
    `/v2/bot/audienceGroup/list?page=1&size=40&description=${encodeURIComponent(description)}`,
  );
  // description 검색은 부분 일치라 정확히 같은 것만 고른다. 실패한 목록은 버린다.
  const usable = (res.audienceGroups ?? []).filter(
    (g) => g.description === description && g.status !== 'FAILED' && g.status !== 'EXPIRED',
  );
  return usable.sort((a, b) => b.audienceGroupId - a.audienceGroupId)[0] ?? null;
}

async function getAudience(id: number): Promise<AudienceGroup> {
  const res = await lineGet<{ audienceGroup: AudienceGroup }>(`/v2/bot/audienceGroup/${id}`);
  return res.audienceGroup;
}

async function uploadAudience(description: string, ids: string[]): Promise<AudienceGroup> {
  if (ids.length > AUDIENCE_UPLOAD_MAX) {
    throw new Error(`연결 고객이 ${AUDIENCE_UPLOAD_MAX}명을 넘었습니다 — 오디언스 추가 업로드를 구현해야 합니다`);
  }
  const res = await fetch('https://api.line.me/v2/bot/audienceGroup/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken()}` },
    body: JSON.stringify({
      description,
      isIfaAudience: false,
      audiences: ids.map((id) => ({ id })),
    }),
  });
  if (!res.ok) throw new Error(`제외 목록 업로드 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { audienceGroupId: number };
  return getAudience(body.audienceGroupId);
}

/** 오늘 발송용 제외 목록을 찾거나 만든다. READY 가 될 때까지 잠깐 기다린다 */
async function ensureExcludeAudience(campaignId: string, ids: string[]): Promise<AudienceGroup> {
  const description = excludeDescription(campaignId);
  let group = (await findAudience(description)) ?? (await uploadAudience(description, ids));
  const deadline = Date.now() + AUDIENCE_WAIT_MS;
  while (group.status !== 'READY' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    group = await getAudience(group.audienceGroupId);
  }
  return group;
}

// ─── narrowcast ──────────────────────────────────────────────────────────────

async function narrowcastExcluding(
  audienceGroupId: number,
  text: string,
  campaignId: string,
): Promise<{ ok: boolean; status: number; requestId: string | null; body: string }> {
  const res = await fetch('https://api.line.me/v2/bot/message/narrowcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${lineToken()}`,
      // 같은 캠페인이면 같은 키 — 응답을 못 받고 다시 눌러도 LINE 이 두 번 보내지 않는다
      'X-Line-Retry-Key': retryKey(campaignId, 0),
    },
    body: JSON.stringify({
      messages: [{ type: 'text', text }],
      // 전체 친구 중 「연결된 사람 목록」에 없는 사람
      recipient: { type: 'operator', not: { type: 'audience', audienceGroupId } },
    }),
  });
  const body = res.ok ? '' : (await res.text()).slice(0, 300);
  return { ok: res.ok, status: res.status, requestId: res.headers.get('x-line-request-id'), body };
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
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (unauthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, confirm, testUserIds, requestId } = (req.body ?? {}) as {
    action?: string;
    confirm?: boolean;
    testUserIds?: string[];
    requestId?: string;
  };

  try {
    if (action === 'status') {
      if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
        return res.status(400).json({ error: 'requestId 가 필요합니다' });
      }
      const p = await lineGet<Record<string, unknown>>(
        `/v2/bot/message/progress/narrowcast?requestId=${requestId}`,
      );
      return res.status(200).json({ ok: true, progress: p });
    }

    const built = build();

    if (action === 'preview') {
      const ids = await linkedLineIds();
      const [est, quota, last] = await Promise.all([
        estimate(ids),
        fetchQuota(),
        lastRealInvite().catch((err: Error) => `확인 실패: ${err.message}`),
      ]);
      return res.status(200).json({
        ok: true,
        text: built.text,
        campaignId: built.campaignId,
        utm: built.campaign,
        estimate: est,
        quota,
        lastInvite: last,
        quietHours: inQuietHours(),
      });
    }

    if (action !== 'send') return res.status(400).json({ error: 'action 은 preview · send · status 입니다' });

    // ── 여기부터는 실제로 사람에게 메시지가 나간다 ──
    if (!confirm) return res.status(400).json({ error: '발송에는 confirm: true 가 필요합니다' });

    const isTest = Array.isArray(testUserIds) && testUserIds.length > 0;
    if (isTest) {
      const ids = Array.from(new Set(testUserIds.filter((id) => typeof id === 'string' && /^U[0-9a-f]{32}$/.test(id))));
      if (ids.length === 0) return res.status(400).json({ error: '테스트 수신자 ID 형식이 올바르지 않습니다' });
      if (ids.length > 10) return res.status(400).json({ error: '테스트 발송은 10명까지입니다' });
      const campaignId = `${built.campaignId}_test`;
      const r = await multicast(ids, built.text, campaignId, Date.now());
      await logCampaign(campaignId, { campaignId, name: CAMPAIGN_NAME, test: true, recipients: ids.length, sent: r.ok ? ids.length : 0 });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, test: true, sent: r.ok ? ids.length : 0, error: r.ok ? undefined : `LINE ${r.status}: ${r.body}` });
    }

    if (inQuietHours()) {
      return res.status(400).json({ error: '조용한 시간(JST 21~09시)에는 보내지 않습니다. 09시 이후에 다시 눌러 주세요' });
    }

    const last = await lastRealInvite();
    if (last) {
      return res.status(409).json({ error: `최근 ${RESEND_GAP_DAYS}일 안에 이미 보냈습니다 (${last}). 같은 사람들에게 다시 가지 않게 막았습니다` });
    }

    const ids = await linkedLineIds();
    const [est, quota] = await Promise.all([estimate(ids), fetchQuota()]);
    // 추정이 안 되면 친구 전체가 받는다고 보고 막는다 — 쿼터를 다 쓰면 주문·배송 알림까지 멈춘다
    const need = est.reachable ?? Number.POSITIVE_INFINITY;
    if (quota.remaining !== null && quota.remaining < need) {
      return res.status(400).json({
        error: `남은 쿼터가 부족합니다 — 잔여 ${quota.remaining}통 / 닿는 친구 ${est.reachable ?? '확인 불가'}명. 주문·배송 알림이 멈추지 않게 막았습니다`,
      });
    }

    const group = await ensureExcludeAudience(built.campaignId, ids);
    if (group.status !== 'READY') {
      return res.status(202).json({
        ok: false,
        pending: true,
        message: 'LINE 이 제외 목록(연결된 사람)을 준비 중입니다. 1~2분 뒤 같은 버튼을 다시 눌러 주세요',
        audienceStatus: group.status,
      });
    }

    const r = await narrowcastExcluding(group.audienceGroupId, built.text, built.campaignId);
    const record = {
      campaignId: built.campaignId,
      campaign: built.campaign,
      name: CAMPAIGN_NAME,
      kind: 'narrowcast_exclude_linked',
      test: false,
      requestId: r.requestId,
      audienceGroupId: group.audienceGroupId,
      excluded: ids.length,
      estimatedTargets: est.estimatedTargets,
      ok: r.ok,
      url: INVITE_URL,
    };
    // 성공했을 때만 남긴다. 실패를 남기면 30일 막기에 걸려 다시 못 보낸다.
    // 다시 눌러도 재시도 키가 같아서(24시간) LINE 이 이미 받은 요청이면 두 번 보내지 않는다.
    if (r.ok) await logCampaign(built.campaignId, record);
    if (!r.ok) {
      console.error(`[LINE Invite] 🔴 narrowcast 실패 ${r.status}: ${r.body}`);
      return res.status(502).json({ ok: false, error: `LINE ${r.status}: ${r.body}` });
    }
    return res.status(202).json(record);
  } catch (error) {
    console.error('[LINE Invite] Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : '처리 중 오류가 발생했습니다' });
  }
}
