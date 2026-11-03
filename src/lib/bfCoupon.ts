/**
 * 블랙프라이데이 2026 「LINE 친구 5%」 전용 쿠폰 — 브라우저 쪽 (#274)
 *
 * /bf 화면에서 받으면(서버가 친구 여부를 확인한 뒤 발급) 코드를 여기 저장해 두고,
 * 블프 기간 안이면 결제(cartStore.createCheckout) 때 자동으로 붙인다.
 *
 * 결제 규칙 (11/3 하영 결정)
 *  - 어필리에이트 특별 코드(/discount/)가 있으면 그쪽 우선 — 블프 5% 는 넣지 않는다 (지금 웰컴과 같은 규칙)
 *  - WELCOME10/LINKUP10 과는 「둘 중 큰 쪽 하나」 — 웰컴을 아직 안 썼으면 웰컴(10%), 썼으면 블프 5%
 *  - 웰컴 사용 여부 확인이 실패하면 블프 5% 를 넣는다(이미 쓴 웰컴을 넣으면 할인이 통째로 빠지므로 안전한 쪽)
 *
 * ⚠️ 기간을 늘리면(2주 연장 → 11/22) BF_APPLY_END 한 줄만 바꾼다. 코드 자체는 11/22 까지 살아 있다
 *    (api/line-bf-coupon.ts 의 CODE_ENDS_AT).
 */
export const BF_COUPON_KEY = 'line_bf_discount';
export const BF_PERCENT = 5;
export const BF_APPLY_START = Date.parse('2026-11-09T00:00:00+09:00');
export const BF_APPLY_END = Date.parse('2026-11-15T23:59:59+09:00');

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
