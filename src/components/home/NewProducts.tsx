import { useEffect, useState } from "react";
import { ShopifyProduct, fetchNewProducts, fetchProductDiscounts } from "@/lib/shopify";
import { useDiscountStore } from "@/stores/discountStore";
import { ProductCarousel, ProductCarouselSkeleton } from "./ProductCarousel";

export function NewProducts() {
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const { productDiscounts: discountMap, setProductDiscounts } = useDiscountStore();

  useEffect(() => {
    fetchNewProducts(12)
      .then((result) => {
        const available = result.filter(p =>
          p.node.variants.edges.some(e =>
            e.node.availableForSale &&
            (e.node.quantityAvailable === null || e.node.quantityAvailable > 0)
          )
        );
        setProducts(available);
        const reps: { productId: string; variantId: string }[] = [];
        available.forEach(p => {
          const v = (p.node.variants.edges.find(e => e.node.availableForSale) ?? p.node.variants.edges[0])?.node;
          if (v) reps.push({ productId: p.node.id, variantId: v.id });
        });
        fetchProductDiscounts(reps).then(map => {
          if (Object.keys(map).length === 0) return;
          setProductDiscounts(map);
        }).catch(console.error);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="mt-8"><ProductCarouselSkeleton /></div>;

  return (
    <ProductCarousel
      title="新商品"
      products={products.slice(0, 8)}
      badge={{ label: "NEW", className: "bg-emerald-500 text-white" }}
      discountMap={discountMap}
      moreTo="/?sort=created_at_desc"
      trackName="new"
      className="mt-8"
      style={{ animationDelay: "0.2s" }}
    />
  );
}
