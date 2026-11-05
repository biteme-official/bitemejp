/**
 * 블랙프라이데이 2026 「¥6,000 이상 送料無料」 — 장바구니 안내줄용 (#278)
 *
 * 실제 무료배송은 Shopify 자동 할인 「BLACK FRIDAY ¥6,000以上 送料無料」 가 결제 때 건다
 * (11/9 0:00 ~ 11/22 23:59 JST, 최소 금액 ¥6,000). 여기 값은 장바구니 안내만 맞춘다.
 * ⚠️ 연장하면 Shopify 할인 종료일과 FREE_SHIP_END 를 같이 바꿀 것.
 */
export const FREE_SHIP_THRESHOLD = 6000; // JPY
export const FREE_SHIP_START = Date.parse('2026-11-09T00:00:00+09:00');
export const FREE_SHIP_END = Date.parse('2026-11-22T23:59:59+09:00');

export function isFreeShipActive(now = Date.now()): boolean {
  return now >= FREE_SHIP_START && now <= FREE_SHIP_END;
}
