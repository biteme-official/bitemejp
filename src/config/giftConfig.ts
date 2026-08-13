export const GIFT_PRODUCT_ID = '10244037017913'; // BITE ME サマーうちわ
export const GIFT_THRESHOLD = 5000; // JPY
export const GIFT_DISCOUNT_CODE = 'GIFT-UCHIWA-2026';

/** 판정에 필요한 최소한의 카트 라인 형태 (cartStore 의 CartItem 이 이 모양을 만족한다) */
export interface GiftCartLine {
  product?: { node?: { id?: string } };
  price: { amount: string };
  quantity: number;
  isGift?: boolean;
}

/**
 * 이 라인이 증정품(うちわ)인지.
 *
 * `isGift` 는 브라우저 localStorage 의 카트에만 존재하는 플래그라 유실될 수 있다.
 * 플래그만 믿으면 증정 쿠폰이 전송되지 않아 **고객이 자격이 되는데도 정가를 낸다**
 * (2026-06~08 사이 11건 발생 — Issue #126). 상품 ID 로도 확인한다.
 */
export function isGiftLine(item: GiftCartLine): boolean {
  if (item.isGift) return true;
  const id = item.product?.node?.id;
  return typeof id === 'string' && id.endsWith(`/${GIFT_PRODUCT_ID}`);
}

/** 증정품을 뺀 소계. 증정품 자신은 임계값 계산에 넣지 않는다. */
export function qualifyingSubtotal(items: GiftCartLine[]): number {
  return items
    .filter((i) => !isGiftLine(i))
    .reduce((sum, i) => sum + parseFloat(i.price.amount) * i.quantity, 0);
}

/**
 * 체크아웃에 증정 쿠폰을 실어 보낼지.
 * 카트에 증정품이 있고 나머지 금액이 임계값 이상이면 보낸다.
 * Shopify 는 해당 없는 코드를 무시하므로, 애매하면 보내는 쪽이 안전하다.
 */
export function shouldSendGiftCode(items: GiftCartLine[]): boolean {
  return items.some(isGiftLine) && qualifyingSubtotal(items) >= GIFT_THRESHOLD;
}
