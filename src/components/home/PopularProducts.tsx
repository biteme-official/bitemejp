import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ShopifyProduct, fetchBestSellingProducts, formatPrice } from "@/lib/shopify";
import { Skeleton } from "@/components/ui/skeleton";

const BADGES = ["BEST", "人気", "おすすめ", "TOP", "新着", "注目"];

export function PopularProducts() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBestSellingProducts(8)
      .then((result) => setProducts(result))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <section className="mt-6 pb-4">
        <div className="flex items-center justify-between px-4 mb-3">
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="grid grid-cols-3 gap-3 px-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-card rounded-xl border border-border overflow-hidden">
              <Skeleton className="aspect-square w-full" />
              <div className="p-3 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (products.length === 0) return null;

  return (
    <section className="mt-6 pb-4 animate-fade-up" style={{ animationDelay: "0.3s" }}>
      <div className="flex items-center justify-between px-4 mb-3">
        <h2 className="text-base font-bold text-foreground">人気商品</h2>
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          すべて見る
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 px-4">
        {products.slice(0, 6).map((product, index) => {
          const image = product.node.images.edges[0]?.node;
          const price = product.node.priceRange.minVariantPrice;

          return (
            <div
              key={product.node.id}
              onClick={() => navigate(`/product/${product.node.handle}`)}
              className="bg-card rounded-xl border border-border overflow-hidden shadow-sm hover:shadow-card transition-all hover:-translate-y-0.5 cursor-pointer"
            >
              <div className="aspect-square bg-secondary relative overflow-hidden">
                {image ? (
                  <img
                    src={image.url}
                    alt={image.altText || product.node.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
                    No Image
                  </div>
                )}
                <span className="absolute top-2 left-2 bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                  {BADGES[index] ?? "人気"}
                </span>
              </div>
              <div className="p-3">
                <h3 className="text-xs font-medium text-foreground line-clamp-2 mb-1 min-h-[32px]">
                  {product.node.title}
                </h3>
                <div
                  className="jdgm-widget jdgm-preview-badge mb-1"
                  data-id={product.node.handle}
                />
                <p className="text-sm font-bold text-primary" translate="no">
                  {formatPrice(price.amount, price.currencyCode)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
