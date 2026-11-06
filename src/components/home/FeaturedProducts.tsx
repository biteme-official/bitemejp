import { useEffect, useState } from "react";
import { fetchProductByHandle, fetchProductDiscounts, ShopifyProduct } from "@/lib/shopify";
import { isHiddenSoldOut, isProductAvailable } from "@/lib/productStock";
import { useDiscountStore } from "@/stores/discountStore";
import { ProductBadge } from "./ProductCard";
import { ProductCarousel } from "./ProductCarousel";

interface FeaturedProductsProps {
  title: string;
  /** 보여 줄 상품 핸들 — 이 순서대로. 공개된 상품이 없으면 구역을 그리지 않는다 */
  handles: string[];
  badge?: ProductBadge;
  /** 지금 살 수 있는 상품만 보여 준다. 끄면 COMING SOON·일시품절도 나온다 */
  availableOnly?: boolean;
  moreLabel?: string;
  moreTo?: string;
  trackName: string;
}

/** 메인 특집 — 상품을 직접 지정한 캐러셀 (config/homeFeatures) */
export function FeaturedProducts({ title, handles, badge, availableOnly, moreLabel, moreTo, trackName }: FeaturedProductsProps) {
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const { productDiscounts: discountMap, setProductDiscounts } = useDiscountStore();

  useEffect(() => {
    let alive = true;
    Promise.all(handles.map((handle) => fetchProductByHandle(handle).catch(() => null))).then((nodes) => {
      if (!alive) return;
      const list = nodes
        .flatMap((node): ShopifyProduct[] => (node ? [{ node }] : []))
        .filter((p) => (availableOnly ? isProductAvailable(p) : !isHiddenSoldOut(p)));
      setProducts(list);

      const reps: { productId: string; variantId: string }[] = [];
      list.forEach((p) => {
        const v = (p.node.variants.edges.find((e) => e.node.availableForSale) ?? p.node.variants.edges[0])?.node;
        if (v) reps.push({ productId: p.node.id, variantId: v.id });
      });
      fetchProductDiscounts(reps)
        .then((map) => {
          if (alive && Object.keys(map).length > 0) setProductDiscounts(map);
        })
        .catch(console.error);
    });
    return () => {
      alive = false;
    };
  }, [handles, availableOnly, setProductDiscounts]);

  if (products.length === 0) return null;

  return (
    <ProductCarousel
      title={title}
      products={products}
      badge={badge}
      discountMap={discountMap}
      moreLabel={moreLabel}
      moreTo={moreTo}
      trackName={trackName}
      trackSource="home_feature"
      className="mt-8"
    />
  );
}
