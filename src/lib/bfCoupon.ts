/**
 * 블랙프라이데이 2026 「LINE 친구 5%」 전용 쿠폰 — 브라우저 쪽 (#274)
 *
 * /bf 화면에서 받으면(서버가 친구 여부를 확인한 뒤 발급) 코드를 여기 저장해 두고,
 * 블프 기간 안이면 결제(cartStore.createCheckout) 때 자동으로 붙인다.
 * 이 브라우저에 코드가 없으면 결제 때 LINE 계정으로 서버에 물어본다 — 다른 기기에서 받은 쿠폰도 붙는다.
 *
 * 결제 규칙 (11/3 하영 결정)
 *  - 어필리에이트 특별 코드(/discount/)가 있으면 그쪽 우선 — 블프 5% 는 넣지 않는다 (지금 웰컴과 같은 규칙)
 *  - WELCOME10/LINKUP10 과는 「둘 중 큰 쪽 하나」 — 웰컴을 아직 안 썼으면 웰컴(10%), 썼으면 블프 5%
 *  - 웰컴 사용 여부 확인이 실패하면 블프 5% 를 넣는다(이미 쓴 웰컴을 넣으면 할인이 통째로 빠지므로 안전한 쪽)
 *
 * 운영 기간 11/9 10:00~11/22 (11/5 2주 확정). 기간을 바꾸면 BF_APPLY_END 와 Shopify 코드 유효기간을 같이 바꾼다
 *    (api/line-bf-coupon.ts 의 CODE_ENDS_AT).
 */
export const BF_COUPON_KEY = 'line_bf_discount';
export const BF_PERCENT = 5;
export const BF_APPLY_START = Date.parse('2026-11-09T10:00:00+09:00');
export const BF_APPLY_END = Date.parse('2026-11-22T23:59:59+09:00');

export function isBfActive(now = Date.now()): boolean {
  return now >= BF_APPLY_START && now <= BF_APPLY_END;
}

/** 받아 둔 코드 — 기간 밖이면 null */
export function activeBfCode(now = Date.now()): string | null {
  if (!isBfActive(now)) return null;
  try {
    const v = localStorage.getItem(BF_COUPON_KEY);
    return v && /^BF5-[0-9A-F]{10}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** 서버 조회가 늦어도 결제를 막지 않게 이 시간만 기다린다 */
const LOOKUP_TIMEOUT_MS = 3000;

/** 계정으로 받은 코드 조회 — 못 받았으면 'none', 조회 실패·시간 초과는 null */
async function lookupBfCode(lineSessionToken: string): Promise<{ code: string; used: boolean } | 'none' | null> {
  try {
    const res = await fetch('/api/line-bf-coupon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineSessionToken, action: 'lookup' }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { status?: string; code?: string; used?: boolean };
    if (body.status === 'none') return 'none';
    if (body.status !== 'ok' || typeof body.code !== 'string') return null;
    return { code: body.code, used: body.used === true };
  } catch {
    return null;
  }
}

/**
 * 결제에 쓸 코드 — 이 브라우저에 있으면 그것, 없으면 계정으로 받은 코드를 찾는다.
 * 조회 실패·시간 초과·미수령·이미 사용은 전부 null(쿠폰 없이 결제 진행).
 */
export async function resolveBfCode(lineSessionToken: string | undefined): Promise<string | null> {
  const local = activeBfCode();
  if (local || !lineSessionToken || !isBfActive()) return local;
  const found = await lookupBfCode(lineSessionToken);
  if (!found || found === 'none' || found.used) return null;
  try { localStorage.setItem(BF_COUPON_KEY, found.code); } catch { /* 이번 결제에는 그대로 쓴다 */ }
  return found.code;
}

export type BfCouponStatus = 'unclaimed' | 'available' | 'used' | 'unknown';

/** 마이페이지 표시용 상태 — 조회 실패는 'unknown' */
export async function getBfCouponStatus(lineSessionToken: string): Promise<BfCouponStatus> {
  const found = await lookupBfCode(lineSessionToken);
  if (!found) return 'unknown';
  if (found === 'none') return 'unclaimed';
  return found.used ? 'used' : 'available';
}

export type BfClaimResult =
  | { status: 'ok'; code: string }
  | { status: 'not_friend' }
  | { status: 'unauthorized' }
  | { status: 'ended' }
  | { status: 'error' };

export async function claimBfCoupon(lineSessionToken: string): Promise<BfClaimResult> {
  try {
    const res = await fetch('/api/line-bf-coupon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineSessionToken }),
    });
    if (res.status === 401) return { status: 'unauthorized' };
    if (res.status === 410) return { status: 'ended' };
    const body = (await res.json().catch(() => ({}))) as { status?: string; code?: string };
    if (res.ok && body.status === 'not_friend') return { status: 'not_friend' };
    if (res.ok && body.status === 'ok' && typeof body.code === 'string') {
      try { localStorage.setItem(BF_COUPON_KEY, body.code); } catch { /* 결제 자동 적용만 빠진다 */ }
      return { status: 'ok', code: body.code };
    }
    return { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}
