/**
 * LINE 로그인 보상 쿠폰 (고객 전용 1회용).
 *
 * 예전에는 공개 코드(WELCOME10)를 로그인 보상으로 썼는데, 그러면 로그인하지 않아도
 * 코드만 알면 쓸 수 있다. Shopify 고객 세그먼트로 제한해도 소용이 없었다 — 우리 프론트가
 * 익명 카트를 넘기므로 결제 시 고객이 식별되지 않아 세그먼트 조건이 판정되지 않는다
 * (2026-08-10 실측: 비로그인 결제화면에서도 10% 그대로 적용).
 *
 * 그래서 로그인 직후 서버가 **그 고객만 쓸 수 있는 코드**를 발급한다(api/line-welcome-coupon.ts).
 * 유출돼도 지정된 고객 외에는 사용할 수 없다.
 *
 * 흐름: 로그인 성공(LineCallback) → 쿠폰 발급 요청 → 아래 키에 저장 → 체크아웃에서 자동 적용(cartStore).
 */

/** localStorage 키 — affiliate_discount 와 별도. 우선순위: 어필리에이트 > 웰컴 */
export const LINE_WELCOME_DISCOUNT_KEY = 'line_welcome_discount';

/** 배너·버튼 문구에 쓰는 할인율. 서버(api/line-welcome-coupon.ts)의 값과 함께 관리한다. */
export const LINE_WELCOME_DISCOUNT_LABEL = '10%OFF';

export interface WelcomeCoupon {
  code: string;
  /** ISO 8601 */
  expiresAt: string;
}

export function saveWelcomeCoupon(coupon: WelcomeCoupon): void {
  try {
    localStorage.setItem(LINE_WELCOME_DISCOUNT_KEY, JSON.stringify(coupon));
  } catch {
    /* 저장 실패해도 로그인 흐름은 계속된다 */
  }
}

/**
 * 아직 유효한 쿠폰 코드를 돌려준다. 만료됐거나 없으면 null.
 * 체크아웃에 만료된 코드를 실어 보내면 Shopify 가 거절하므로 여기서 걸러낸다.
 */
export function readWelcomeCode(): string | null {
  try {
    const raw = localStorage.getItem(LINE_WELCOME_DISCOUNT_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (typeof parsed?.code !== 'string' || typeof parsed?.expiresAt !== 'string') return null;
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;

    return parsed.code;
  } catch {
    return null;
  }
}

/** 로그인 직후 호출. 실패해도 로그인 자체는 성공으로 둔다. */
export async function requestWelcomeCoupon(lineSessionToken: string): Promise<WelcomeCoupon | null> {
  try {
    const res = await fetch('/api/line-welcome-coupon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineSessionToken }),
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (typeof data?.code !== 'string' || typeof data?.expiresAt !== 'string') return null;

    const coupon: WelcomeCoupon = { code: data.code, expiresAt: data.expiresAt };
    saveWelcomeCoupon(coupon);
    return coupon;
  } catch {
    return null;
  }
}
