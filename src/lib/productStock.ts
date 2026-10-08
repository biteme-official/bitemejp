import type { ShopifyProduct } from "@/lib/shopify";

/** 옵션 중 하나라도 살 수 있으면 판매 중 */
export function isProductAvailable(p: ShopifyProduct): boolean {
  return p.node.variants.edges.some((e) => e.node.availableForSale);
}

/**
 * 품절 상품을 빼지 않고 맨 뒤로 보낸다 (#219). 판매 중인 상품끼리의 순서(정렬·추천순)는 그대로 둔다.
 *
 * 2026-05 까지는 목록에서 품절을 통째로 지웠는데, 그러면 고객이 검색해도 상품이 안 나오고
 * 상세의 「再入荷をLINEで受け取る」까지 올 길이 없다.
 */
export function soldOutLast(products: ShopifyProduct[]): ShopifyProduct[] {
  return [...products.filter(isProductAvailable), ...products.filter((p) => !isProductAvailable(p))];
}
