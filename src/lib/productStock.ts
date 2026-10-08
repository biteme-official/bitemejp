import type { ShopifyProduct } from "@/lib/shopify";

/**
 * 품절 구분 (#223) — 일시품절은 보여 주고 재입고 알림을 받고, 판매 종료는 숨긴다.
 *
 * Shopify 상품 태그로 정한다. 태그가 없으면 일시품절로 본다.
 *   - `販売終了`              상품 전체가 판매 종료
 *   - `販売終了:<옵션명>`      그 옵션만 판매 종료 (옵션명은 「M / ピンク」처럼 Shopify 옵션 표시 그대로)
 * `discontinued`·`단종` 도 같은 뜻으로 받는다.
 *
 * 판매 종료여도 재고가 남아 있으면 그대로 판다. 다 팔리면 목록에서 빠지고 재입고 알림도 없다.
 * api/line-restock.ts 에 같은 규칙이 한 벌 더 있다(서버는 src 를 import 하지 않는다) — 같이 고칠 것.
 */
const DISCONTINUED_TAGS = ["販売終了", "discontinued", "단종"];

function tagRule(tag: string): { variant: string | null } | null {
  const t = tag.trim();
  for (const key of DISCONTINUED_TAGS) {
    if (t.toLowerCase() === key.toLowerCase()) return { variant: null };
    const prefix = `${key}:`;
    if (t.toLowerCase().startsWith(prefix.toLowerCase())) return { variant: t.slice(prefix.length).trim() };
  }
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** 이 옵션이 판매 종료인가 (상품 태그 기준) */
export function isVariantDiscontinued(tags: string[] | undefined, variantTitle: string): boolean {
  for (const tag of tags ?? []) {
    const r = tagRule(tag);
    if (!r) continue;
    if (r.variant === null || norm(r.variant) === norm(variantTitle)) return true;
  }
  return false;
}

/** 옵션 중 하나라도 살 수 있으면 판매 중 */
export function isProductAvailable(p: ShopifyProduct): boolean {
  return p.node.variants.edges.some((e) => e.node.availableForSale);
}

/** 목록에서 뺄 상품 — 다 팔렸고, 품절 옵션이 전부 판매 종료(재입고 알림 받을 옵션이 없음) */
export function isHiddenSoldOut(p: ShopifyProduct): boolean {
  if (isProductAvailable(p)) return false;
  return p.node.variants.edges.every((e) => isVariantDiscontinued(p.node.tags, e.node.title));
}
