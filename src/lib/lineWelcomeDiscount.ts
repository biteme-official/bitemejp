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

/**
 * 연결 유도 발송(`src=invite`)으로 들어온 사람에게 주는 쿠폰.
 *
 * WELCOME10 과 조건(10%·1인 1회)은 같지만 **코드를 따로 둔다** — 연결 없이 이메일 계정으로
 * WELCOME10 을 이미 쓴 사람에게도 한 번 더 주기 위해서다. 같은 코드면 Shopify 가 조용히 무시한다.
 * ⚠️ api/line-journey.ts · api/line-invite.ts 에도 같은 코드가 적혀 있다. 바꾸면 셋 다 + Shopify 설정.
 */
export const LINE_INVITE_DISCOUNT_CODE = 'LINKUP10';

/** 로그인 진입 경로별 보상 쿠폰 — 연결 유도 발송만 별도 코드 */
export function welcomeCodeFor(loginSource: string | null | undefined): string {
  return loginSource === 'invite' ? LINE_INVITE_DISCOUNT_CODE : LINE_WELCOME_DISCOUNT_CODE;
}

/** localStorage 키 — affiliate_discount 와 별도로 둔다(우선순위: 어필리에이트 > 웰컴). */
export const LINE_WELCOME_DISCOUNT_KEY = 'line_welcome_discount';

/**
 * 이 브라우저에서 **처음 LINE 연결**을 했다는 표시 (#242).
 * 장바구니 「約 -¥」 줄은 이 표시 + 쿠폰 미사용 확인이 둘 다 있을 때만 보인다 — 기존 연결 고객에겐
 * 안 보인다. 쿠폰 자동 적용(cartStore)은 이 표시와 무관하게 그대로다.
 */
export const LINE_NEW_LINK_KEY = 'line_welcome_new_link';

/** 배너·버튼 문구에 함께 쓰는 할인율. 표기와 실제 설정이 어긋나지 않도록 한곳에서 관리한다. */
export const LINE_WELCOME_DISCOUNT_LABEL = '10%OFF';

/** 파트너 링크 할인과 「큰 쪽」 비교에 쓰는 웰컴 할인율 — 위 표기와 Shopify 설정에 맞출 것 */
export const LINE_WELCOME_DISCOUNT_PERCENT = 10;
