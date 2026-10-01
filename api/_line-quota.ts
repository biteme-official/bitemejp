/**
 * LINE 월 발송 한도 지키기.
 *
 * 🔴 2026-09-24 에 9월 한도 30,000통을 다 썼고, 그 뒤 9/25~9/30 동안 저니·주문 확인·배송 시작·
 *    어필리에이트 알림이 **한 통도 안 나갔다**. LINE 은 한도를 넘으면 push 에 429 를 주는데,
 *    코드는 그걸 그냥 「실패」로 세고 넘어가서 6일 동안 아무도 몰랐다.
 *
 *    9월 사용 내역: 매니저 전체 브로드캐스트 4회(회당 ≈ 친구 수 6,200통) + 매니저 타겟 발송 4,550통
 *    + push 1,700통. 브로드캐스트 한 번이 친구 수만큼 먹으니 **월 4~5회면 한도가 끝난다.**
 *
 * 그래서 두 가지를 한다.
 *   1. 저니·주문 알림 몫으로 `LINE_QUOTA_RESERVE`(기본 3,000통)를 남겨 둔다.
 *      우리 코드에서 나가는 대량 발송(타겟 발송)은 이 예약분을 건드리지 못한다.
 *   2. 매니저 브로드캐스트는 코드가 막을 수 없으니, 단계가 바뀔 때 슬랙으로 알린다.
 *      단계마다 한 달에 한 번만 (Supabase `events` 에 기록해 중복을 막는다).
 */
import { createClient } from '@supabase/supabase-js';

export const QUOTA_ALERT_EVENT = 'line_quota_alert';

/** 저니·주문 알림 몫으로 남겨 둘 통수. 한 달 push 가 1,700~2,000통이라 여유를 둔 값 */
export function quotaReserve(): number {
  const v = Number(process.env.LINE_QUOTA_RESERVE);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}

export type QuotaStage = 'ok' | 'tight' | 'reserve' | 'exhausted';

export interface QuotaStatus {
  limit: number | null;
  used: number;
  remaining: number | null;
  reserve: number;
  /** 전체 브로드캐스트 1회가 쓰는 통수(발송 가능 친구 수). 못 읽으면 null */
  reach: number | null;
  stage: QuotaStage;
}

/**
 * - `tight`     : 전체 브로드캐스트를 한 번 더 하면 예약분까지 먹는다
 * - `reserve`   : 이미 예약분 안쪽이다 — 저니·주문 알림만 남길 것
 * - `exhausted` : 다 썼다 — 주문 알림도 안 나간다
 */
export function quotaStage(remaining: number | null, reserve: number, reach: number | null): QuotaStage {
  if (remaining === null) return 'ok'; // 무제한 플랜
  if (remaining <= 0) return 'exhausted';
  if (remaining <= reserve) return 'reserve';
  if (reach !== null && remaining - reserve < reach) return 'tight';
  return 'ok';
}

/** LINE 이 월 한도 초과로 거절했는가. 429 는 초당 레이트리밋에도 쓰여서 본문까지 본다 */
export function isMonthlyLimitError(status: number, body: string): boolean {
  return status === 429 && /monthly limit/i.test(body);
}

function lineToken(): string | null {
  return process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN || null;
}

async function lineGet<T>(path: string): Promise<T | null> {
  const token = lineToken();
  if (!token) return null;
  const res = await fetch(`https://api.line.me${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** yyyymmdd (JST) */
function jstDate(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 이번 달 키 (JST). LINE 한도는 JST 기준 매월 1일에 다시 찬다 */
function jstMonth(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 7);
}

/** 발송 가능 친구 수. 인사이트는 2~3일 늦게 확정돼서 최근 확정값을 찾는다 */
async function fetchReach(now: number): Promise<number | null> {
  for (const back of [2, 3, 4]) {
    const d = await lineGet<{ status?: string; targetedReaches?: number }>(
      `/v2/bot/insight/followers?date=${jstDate(now - back * 86_400_000)}`,
    );
    if (d?.status === 'ready' && typeof d.targetedReaches === 'number') return d.targetedReaches;
  }
  return null;
}

export async function fetchQuotaStatus(now = Date.now()): Promise<QuotaStatus | null> {
  const [quota, consumption, reach] = await Promise.all([
    lineGet<{ type?: string; value?: number }>('/v2/bot/message/quota'),
    lineGet<{ totalUsage?: number }>('/v2/bot/message/quota/consumption'),
    fetchReach(now),
  ]);
  if (!quota || !consumption) return null;
  // type:'none' 이면 무제한 플랜이라 value 가 없다
  const limit = typeof quota.value === 'number' ? quota.value : null;
  const used = Number(consumption.totalUsage ?? 0);
  const remaining = limit === null ? null : Math.max(0, limit - used);
  const reserve = quotaReserve();
  return { limit, used, remaining, reserve, reach, stage: quotaStage(remaining, reserve, reach) };
}

const fmt = (n: number | null) => (n === null ? '―' : n.toLocaleString('ko-KR'));

export function quotaAlertText(s: Pick<QuotaStatus, 'stage' | 'remaining' | 'reserve' | 'reach'>): string {
  switch (s.stage) {
    case 'tight':
      return `🟡 LINE 남은 한도 ${fmt(s.remaining)}통 — 전체 브로드캐스트(약 ${fmt(s.reach)}통) 한 번이면 주문 알림·저니 몫 ${fmt(s.reserve)}통까지 씁니다. 이번 달 추가 발송은 ${fmt(Math.max(0, (s.remaining ?? 0) - s.reserve))}통 이내로.`;
    case 'reserve':
      return `🟠 LINE 남은 한도 ${fmt(s.remaining)}통 (예약분 ${fmt(s.reserve)}통 이하) — 이번 달 브로드캐스트·타겟 발송 중단, 주문 알림·저니만 남깁니다.`;
    case 'exhausted':
      return '🔴 LINE 이번 달 한도 소진 — 다음 달 1일까지 주문 확인·배송·저니 알림이 안 나갑니다. LINE 매니저에서 추가 메시지 상한 확인 필요.';
    default:
      return '';
  }
}

/**
 * 단계가 `ok` 가 아니면 슬랙으로 알린다. 같은 달·같은 단계는 한 번만.
 * 절대 throw 하지 않는다 — 알림 실패가 발송을 막으면 안 된다.
 */
export async function alertQuota(
  s: Pick<QuotaStatus, 'stage' | 'remaining' | 'reserve' | 'reach'>,
  now = Date.now(),
): Promise<boolean> {
  if (s.stage === 'ok') return false;
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = url && key ? createClient(url, key) : null;
    const sessionId = `quota:${jstMonth(now)}:${s.stage}`;

    if (db) {
      const { data, error } = await db
        .from('events')
        .select('id')
        .eq('event_type', QUOTA_ALERT_EVENT)
        .eq('session_id', sessionId)
        .limit(1);
      if (!error && (data ?? []).length > 0) return false;
    }

    const text = quotaAlertText(s);
    console.error(`[LINE Quota] ${text}`);
    const webhook = process.env.SLACK_WEBHOOK_URL;
    if (webhook) {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    }

    if (db) {
      await db.from('events').insert({
        event_type: QUOTA_ALERT_EVENT,
        session_id: sessionId,
        properties: { stage: s.stage, remaining: s.remaining, reserve: s.reserve, reach: s.reach },
        page_path: '/api/line-quota',
        referrer: null,
      });
    }
    return true;
  } catch (e) {
    console.error('[LINE Quota] 알림 실패:', e);
    return false;
  }
}

/** push 가 월 한도로 거절됐을 때. 남은 수를 다시 묻지 않고 바로 소진 알림을 낸다 */
export function alertExhausted(now = Date.now()): Promise<boolean> {
  return alertQuota({ stage: 'exhausted', remaining: 0, reserve: quotaReserve(), reach: null }, now);
}
