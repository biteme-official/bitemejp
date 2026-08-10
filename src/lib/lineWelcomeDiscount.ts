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
