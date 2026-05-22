import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ShopifyProduct, fetchNewProducts, formatPrice, getPreorderDate, fetchCartPreview } from "@/lib/shopify";
import { Skeleton } from "@/components/ui/skeleton";
import { useDiscountStore } from "@/stores/discountStore";

export function NewProducts() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [localDiscountMap, setLocalDiscountMap] = useState<Record<string, number>>({});
  const { productDiscounts: globalDiscountMap } = useDiscountStore();
  const discountMap = { ...globalDiscountMap, ...localDiscountMap };

  useEffect(() => {
    fetchNewProducts(12)
      .then((result) => {
        const available = result.filter(p =>
          p.node.variants.edges.some(e => e.node.availableForSale)
        );
        setProducts(available);
        const variants: { variantId: string; quantity: number }[] = [];
        result.forEach(p => {
          const v = (p.node.variants.edges.find(e => e.node.availableForSale) ?? p.node.variants.edges[0])?.node;
          if (v) variants.push({ variantId: v.id, quantity: 1 });
        });
        fetchCartPreview(variants).then(info => {
          if (!info || Object.keys(info.productDiscounts).length === 0) return;
          setLocalDiscountMap(info.productDiscounts);
        });
      })
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
    <section className="mt-6 pb-4 animate-fade-up" style={{ animationDelay: "0.2s" }}>
      <div className="flex items-center justify-between px-4 mb-3">
        <h2 className="text-base font-bold text-foreground">新商品</h2>
        <button
          onClick={() => navigate("/?sort=created_at_desc")}
          className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          すべて見る
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-3 md:gap-4 px-4 overflow-x-auto pb-2 scrollbar-hide">
        {products.slice(0, 6).map((product) => {
          const image = product.node.images.edges[0]?.node;
          const price = product.node.priceRange.minVariantPrice;

          return (
            <div
              key={product.node.id}
              onClick={() => navigate(`/product/${product.node.id.split('/').pop()}`)}
              className="flex-shrink-0 w-36 md:w-56 bg-card rounded-xl border border-border overflow-hidden shadow-sm hover:shadow-card transition-all cursor-pointer"
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
                <span className="absolute top-2 left-2 bg-emerald-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                  NEW
                </span>
                {(() => {
                  const pct = discountMap[product.node.id] ?? 0;
                  const originalAmt = parseFloat(price.amount);
                  const compareAt = product.node.variants.edges[0]?.node.compareAtPrice;
                  const finalPct = pct || (compareAt && parseFloat(compareAt.amount) > originalAmt
                    ? Math.round((1 - originalAmt / parseFloat(compareAt.amount)) * 100) : 0);
                  if (!finalPct) return null;
                  return (
                    <span className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                      -{finalPct}%
                    </span>
                  );
                })()}
                {getPreorderDate(product.node.tags ?? []) && (
                  <span className="absolute bottom-2 left-2 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                    予約
                  </span>
                )}
              </div>
              <div className="p-3">
                <h3 className="text-xs font-medium text-foreground line-clamp-2 mb-1 min-h-[32px]">
                  {product.node.title}
                </h3>
                <div
                  className="jdgm-widget jdgm-preview-badge mb-1"
                  data-id={product.node.id?.split('/').pop()}
                  data-handle={product.node.handle}
                />
                {(() => {
                  const pct = discountMap[product.node.id] ?? 0;
                  const originalAmt = parseFloat(price.amount);
                  const compareAt = product.node.variants.edges[0]?.node.compareAtPrice;
                  if (pct) {
                    return (
                      <div>
                        <span className="text-sm font-bold text-red-500" translate="no">
                          {formatPrice((originalAmt * (1 - pct / 100)).toFixed(0), price.currencyCode)}
                        </span>
                        <span className="ml-1 text-[10px] text-muted-foreground line-through" translate="no">
                          {formatPrice(price.amount, price.currencyCode)}
                        </span>
                      </div>
                    );
                  } else if (compareAt && parseFloat(compareAt.amount) > originalAmt) {
                    return (
                      <div>
                        <span className="text-sm font-bold text-red-500" translate="no">
                          {formatPrice(price.amount, price.currencyCode)}
                        </span>
                        <span className="ml-1 text-[10px] text-muted-foreground line-through" translate="no">
                          {formatPrice(compareAt.amount, compareAt.currencyCode)}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <p className="text-sm font-bold text-primary" translate="no">
                      {formatPrice(price.amount, price.currencyCode)}
                    </p>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
