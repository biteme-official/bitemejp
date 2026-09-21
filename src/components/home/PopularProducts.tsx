import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShopifyProduct, fetchBestSellingProducts, fetchProductDiscounts } from "@/lib/shopify";
import { useDiscountStore } from "@/stores/discountStore";
import { ProductCarousel, ProductCarouselSkeleton } from "./ProductCarousel";

export function PopularProducts() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const { productDiscounts: discountMap, setProductDiscounts } = useDiscountStore();

  useEffect(() => {
    fetchBestSellingProducts(12)
      .then((result) => {
        const available = result.filter(p =>
          p.node.variants.edges.some(e => e.node.availableForSale)
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
      title="人気商品"
      products={products.slice(0, 8)}
      badge={{ label: "BEST" }}
      discountMap={discountMap}
      onMore={() => navigate("/?collection=%E4%BA%BA%E6%B0%97%E5%95%86%E5%93%81")}
      trackName="best_selling"
      className="mt-8"
      style={{ animationDelay: "0.3s" }}
    />
  );
}
