import type { ShopifyProduct } from "@/lib/shopify";

/** 옵션 중 하나라도 살 수 있으면 판매 중 */
export function isProductAvailable(p: ShopifyProduct): boolean {
  return p.node.variants.edges.some((e) => e.node.availableForSale);
}

