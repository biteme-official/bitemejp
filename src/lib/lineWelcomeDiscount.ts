/**
 * LINE 로그인 보상 쿠폰.
 *
 * 원래는 "친구추가하면 10%OFF" 로 안내하고 있었는데, 친구추가만으로는 Shopify 고객과
 * LINE userId 가 연결되지 않는다. 로그인 흐름에는 친구추가 단계(bot_prompt)가 이미
 * 포함돼 있어 로그인 쪽이 상위 호환이므로, 쿠폰을 로그인 보상으로 옮겼다.
 *
 * 흐름: 로그인 성공(LineCallback) → 아래 키에 코드 저장 → 체크아웃 생성 시 자동 적용(cartStore).
 *
 * ⚠️ 1인 1회 제한은 Shopify 쪽 설정이 강제한다. 여기서 소진 여부를 추적하지 않으므로
 *    이미 쓴 사람은 Shopify 가 조용히 무시한다(주문은 정상 진행).
 * ⚠️ 코드를 바꾸면 Shopify 할인 설정의 코드도 함께 바꿔야 한다.
 */
export const LINE_WELCOME_DISCOUNT_CODE = 'WELCOME10';

/** localStorage 키 — affiliate_discount 와 별도로 둔다(우선순위: 어필리에이트 > 웰컴). */
export const LINE_WELCOME_DISCOUNT_KEY = 'line_welcome_discount';

/** 배너·버튼 문구에 함께 쓰는 할인율. 표기와 실제 설정이 어긋나지 않도록 한곳에서 관리한다. */
export const LINE_WELCOME_DISCOUNT_LABEL = '10%OFF';

/** 파트너 링크 할인과 「큰 쪽」 비교에 쓰는 웰컴 할인율 — 위 표기와 Shopify 설정에 맞출 것 */
export const LINE_WELCOME_DISCOUNT_PERCENT = 10;

/**
 * 택배 동봉 안내지(QR) 전용 「다음 구매 10%OFF」 코드.
 *
 * 안내지를 받는 사람은 이미 한 번 산 고객이라 대부분 `WELCOME10`(1인 1회)을 첫 구매 때 썼다.
 * 그 코드를 다시 넣으면 Shopify 가 조용히 무시해서 「LINE 연결하면 10%OFF」 약속이 빈말이 된다.
 * 그래서 안내지로 들어온 로그인에는 별도 코드를 예약한다. 할인율은 웰컴과 같아(10%) 위 PERCENT 를 그대로 쓴다.
 *
 * 코드는 안내지에 인쇄하지 않는다 — 인쇄하면 LINE 연결 없이 코드만 쓰게 된다. QR → LINE 로그인 → 자동 적용.
 * ⚠️ Shopify 할인 설정(1인 1회·결합 조건)과 코드 문자열을 함께 관리할 것.
 */
export const LINE_INSERT_DISCOUNT_CODE = 'THANKYOU10';

/** `/line-login?src=insert` 로 들어와 LINE 인증을 다녀오는 동안 「안내지 경유」임을 기억하는 표시 */
const INSERT_PENDING_KEY = 'line_insert_pending';

export function markInsertLogin(): void {
  try { localStorage.setItem(INSERT_PENDING_KEY, String(Date.now())); } catch { /* 무시 — 웰컴 코드로 대체된다 */ }
}

/** 이미 로그인된 상태로 안내지 QR 을 찍었을 때 — 인증을 다녀올 필요 없이 바로 예약한다 */
export function reserveInsertDiscount(): void {
  try { localStorage.setItem(LINE_WELCOME_DISCOUNT_KEY, LINE_INSERT_DISCOUNT_CODE); } catch { /* 무시 */ }
}

/**
 * 로그인 직후 예약할 보상 코드. 안내지 경유 표시가 1시간 안에 남아 있으면 전용 코드, 아니면 웰컴 코드.
 * 표시는 한 번 읽으면 지운다 — 다음 로그인(다른 입구)까지 끌려가지 않게.
 */
export function takeLoginRewardCode(): { code: string; fromInsert: boolean } {
  let fromInsert = false;
  try {
    const at = Number(localStorage.getItem(INSERT_PENDING_KEY));
    localStorage.removeItem(INSERT_PENDING_KEY);
    fromInsert = Number.isFinite(at) && at > 0 && Date.now() - at < 3600_000;
  } catch { /* 무시 */ }
  return { code: fromInsert ? LINE_INSERT_DISCOUNT_CODE : LINE_WELCOME_DISCOUNT_CODE, fromInsert };
}
