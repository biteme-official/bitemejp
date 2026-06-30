import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  ShopifyCollection,
  ShopifyProduct,
  fetchCollectionProducts,
  formatPrice,
  getPreorderDate,
  fetchProductDiscounts,
} from "@/lib/shopify";

const CATEGORY_WHITELIST: { handle: string; title: string }[] = [
  { handle: "小さなお口にもぴったり-ミニおもちゃ特集", title: "小さなお口にもぴったり！ミニおもちゃ特集" },
  { handle: "人気商品", title: "人気商品" },
  { handle: "bite-me-choigosim", title: "BITE ME×チェゴシム" },
];
import { Skeleton } from "@/components/ui/skeleton";

interface CategoryData {
  collection: ShopifyCollection;
  products: ShopifyProduct[];
}

const LoadingSkeleton = () => (
  <section className="pb-4">
    <div className="flex items-center justify-between px-4 mb-3">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-4 w-14" />
    </div>
    <div className="flex gap-3 px-4 overflow-x-auto pb-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex-shrink-0 w-36 md:w-56 bg-card rounded-xl border border-border overflow-hidden"
        >
          <Skeleton className="aspect-square w-full" />
          <div className="p-2.5 space-y-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      ))}
    </div>
  </section>
);

export function CategorySections() {
  const navigate = useNavigate();
  const [sections, setSections] = useState<CategoryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [discountMap, setDiscountMap] = useState<Record<string, number>>({});

  useEffect(() => {
    const load = async () => {
      try {
        const results = await Promise.all(
          CATEGORY_WHITELIST.map(async ({ handle, title }) => {
            const res = await fetchCollectionProducts(handle, 8);
            const collection: ShopifyCollection = { id: handle, title, handle, description: "", image: null };
            return { collection, products: res.products };
          })
        );

        const validSections = results
          .map(({ collection, products }) => ({
            collection,
            products: products.filter(p =>
              p.node.variants.edges.some(e => e.node.availableForSale)
            ),
          }))
          .filter((r) => r.products.length >= 4);
        setSections(validSections);
        const reps: { productId: string; variantId: string }[] = [];
        const seen = new Set<string>();
        validSections.flatMap(r => r.products).forEach(p => {
          if (seen.has(p.node.id)) return;
          seen.add(p.node.id);
          const v = (p.node.variants.edges.find(e => e.node.availableForSale) ?? p.node.variants.edges[0])?.node;
          if (v) reps.push({ productId: p.node.id, variantId: v.id });
        });
        fetchProductDiscounts(reps).then(map => {
          if (Object.keys(map).length === 0) return;
          setDiscountMap(map);
        });
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="mt-4 space-y-2">
        <LoadingSkeleton />
        <LoadingSkeleton />
      </div>
    );
  }

  if (sections.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      {sections.map(({ collection, products }) => {
        const collDiscountPct = (() => {
          const match = collection.handle.match(/-(\d+)-off/i);
          return match ? parseInt(match[1], 10) : 0;
        })();

        return (
          <section key={collection.id} className="pb-4 animate-fade-up">
            <div className="flex items-center justify-between px-4 mb-3">
              <h2 className="text-base md:text-lg font-bold text-foreground">
                {collection.title}
              </h2>
              <button
                onClick={() =>
                  navigate(`/?collection=${collection.handle}`)
                }
                className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                もっと見る
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="flex gap-3 md:gap-4 px-4 overflow-x-auto pb-2 scrollbar-hide">
              {products.map((product) => {
                const image = product.node.images.edges[0]?.node;
                const price = product.node.priceRange.minVariantPrice;
                const isAvailable = product.node.variants.edges.some(
                  (v) => v.node.availableForSale
                );

                return (
                  <div
                    key={product.node.id}
                    onClick={() =>
                      navigate(`/product/${product.node.id.split('/').pop()}`)
                    }
                    className="flex-shrink-0 w-36 md:w-56 bg-card rounded-xl border border-border overflow-hidden shadow-sm hover:shadow-card transition-all cursor-pointer"
                  >
                    <div className="aspect-square bg-secondary relative overflow-hidden">
                      {image ? (
                        <img
                          src={image.url}
                          alt={image.altText || product.node.title}
                          className={`w-full h-full object-cover hover:scale-105 transition-transform duration-300 ${
                            !isAvailable ? "opacity-50" : ""
                          }`}
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                          No Image
                        </div>
                      )}
                      {!isAvailable && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="bg-foreground/80 text-background text-[10px] font-bold px-2 py-0.5 rounded">
                            Sold Out
                          </span>
                        </div>
                      )}
                      {isAvailable && (() => {
                        const pct2 = discountMap[product.node.id] ?? 0;
                        const originalAmt = parseFloat(price.amount);
                        const compareAt = product.node.variants.edges[0]?.node.compareAtPrice;
                        const pct = pct2 || collDiscountPct || (compareAt && parseFloat(compareAt.amount) > originalAmt
                          ? Math.round((1 - originalAmt / parseFloat(compareAt.amount)) * 100) : 0);
                        if (!pct) return null;
                        return (
                          <span className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                            -{pct}%
                          </span>
                        );
                      })()}
                      {isAvailable && getPreorderDate(product.node.tags ?? []) && (
                        <span className="absolute top-2 left-2 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                          予約
                        </span>
                      )}
                    </div>
                    <div className="p-2.5 md:p-3">
                      <h3 className="text-[11px] md:text-sm font-medium text-foreground line-clamp-2 mb-1.5 min-h-[28px] md:min-h-[40px]">
                        {product.node.title}
                      </h3>
                      {(() => {
                        const effectivePct = (discountMap[product.node.id] ?? 0) || collDiscountPct;
                        const originalAmt = parseFloat(price.amount);
                        const compareAt = product.node.variants.edges[0]?.node.compareAtPrice;
                        if (effectivePct) {
                          return (
                            <div>
                              <span className="text-xs md:text-sm font-bold text-red-500" translate="no">
                                {formatPrice((originalAmt * (1 - effectivePct / 100)).toFixed(0), price.currencyCode)}
                              </span>
                              <span className="ml-1 text-[10px] text-muted-foreground line-through" translate="no">
                                {formatPrice(price.amount, price.currencyCode)}
                              </span>
                            </div>
                          );
                        } else if (compareAt && parseFloat(compareAt.amount) > originalAmt) {
                          return (
                            <div>
                              <span className="text-xs md:text-sm font-bold text-red-500" translate="no">
                                {formatPrice(price.amount, price.currencyCode)}
                              </span>
                              <span className="ml-1 text-[10px] text-muted-foreground line-through" translate="no">
                                {formatPrice(compareAt.amount, compareAt.currencyCode)}
                              </span>
                            </div>
                          );
                        }
                        return (
                          <p className="text-xs md:text-sm font-bold text-primary" translate="no">
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
      })}
    </div>
  );
}
