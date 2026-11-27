/**
 * 블프 첫 구매자 「두 번째 구매 ¥500 OFF」 쿠폰 — 브라우저 쪽 (#320)
 *
 * 코드는 서버가 대상자에게 미리 만들어 둔다(scripts/issue-thanks-coupon.ts). 고객은 받거나 입력하지 않는다 —
 * LINE 로그인한 사람이 결제하면 cartStore.createCheckout 이 여기서 코드를 찾아 자동으로 붙인다.
 *
 * 결제 규칙
 *  - 어필리에이트 특별 코드(/discount/)가 있으면 그쪽 우선 — 넣지 않는다 (웰컴·블프 5% 와 같은 규칙)
 *  - ¥3,000 미만 카트엔 넣지 않는다 — 조건 미달 코드를 넣으면 다른 쿠폰까지 못 쓰게 된다
 *  - 웰컴(10%)을 아직 안 썼으면 「할인액 큰 쪽 하나」. 주문 할인끼리는 합산되지 않는다
 *
 * 기간을 바꾸면 api/_thanks-coupon.ts 의 THANKS_STARTS_AT·THANKS_ENDS_AT 와 같이 바꾼다.
 */
export const THANKS_AMOUNT = 500;
export const THANKS_MIN_SUBTOTAL = 3000;
export const THANKS_APPLY_START = Date.parse('2026-11-29T00:00:00+09:00');
export const THANKS_APPLY_END = Date.parse('2026-12-13T23:59:59+09:00');

export function isThanksActive(now = Date.now()): boolean {
  return now >= THANKS_APPLY_START && now <= THANKS_APPLY_END;
}

/** 서버 조회가 늦어도 결제를 막지 않게 이 시간만 기다린다 */
const LOOKUP_TIMEOUT_MS = 3000;

export type ThanksCouponStatus = 'none' | 'available' | 'used' | 'unknown';

async function lookup(lineSessionToken: string): Promise<{ code: string; used: boolean } | 'none' | null> {
  try {
    const res = await fetch('/api/line-thanks-coupon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineSessionToken }),
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

/** 결제에 쓸 코드 — 기간 밖·대상 아님·이미 사용·조회 실패는 전부 null(쿠폰 없이 결제 진행) */
export async function resolveThanksCode(lineSessionToken: string | undefined): Promise<string | null> {
  if (!lineSessionToken || !isThanksActive()) return null;
  const found = await lookup(lineSessionToken);
  if (!found || found === 'none' || found.used) return null;
  return found.code;
}

/** 마이페이지 표시용 — 기간 밖·조회 실패는 'unknown'(줄을 숨긴다) */
export async function getThanksCouponStatus(lineSessionToken: string): Promise<ThanksCouponStatus> {
  if (Date.now() > THANKS_APPLY_END) return 'unknown';
  const found = await lookup(lineSessionToken);
  if (!found) return 'unknown';
  if (found === 'none') return 'none';
  return found.used ? 'used' : 'available';
}
