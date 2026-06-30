import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ShopifyProduct, fetchProducts, fetchCollectionProducts, fetchBestSellingProducts, fetchNewProducts, formatPrice, getPreorderDate, fetchProductDiscounts } from '@/lib/shopify';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ShoppingCart, Loader2, Heart } from 'lucide-react';
import { useWishlistStore } from '@/stores/wishlistStore';
import { useDiscountStore } from '@/stores/discountStore';
import { saveScrollPosition } from '@/hooks/useScrollRestoration';
import { ProductFilters, SortOption, FilterState } from './ProductFilters';
import { ProductOptionDialog } from './ProductOptionDialog';
import { useTranslation } from '@/hooks/useTranslation';
import { trackViewItemList, shopifyToGA4Item } from '@/lib/ga4-ecommerce';
import { track } from '@/lib/track';

// Product skeleton component
const ProductSkeleton = () => (
  <div className="bg-card rounded-xl overflow-hidden border border-border">
    <Skeleton className="aspect-square w-full" />
    <div className="p-4 space-y-3">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <div className="flex items-center justify-between pt-1">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
    </div>
  </div>
);

interface ProductGridProps {
  searchQuery?: string;
  collectionHandle?: string | null;
  initialSort?: SortOption;
}

const PRODUCTS_PER_PAGE = 12;
const DEFAULT_MAX_PRICE = 10000;

export const ProductGrid = ({ searchQuery = "", collectionHandle = null, initialSort }: ProductGridProps) => {
  const [allProducts, setAllProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNextPage, setHasNextPage] = useState(false);
  const { productDiscounts: discountMap, setProductDiscounts } = useDiscountStore();
  const { isWishlisted, toggleItem: toggleWishlist } = useWishlistStore();
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [totalProductCount, setTotalProductCount] = useState<number | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Option dialog state
  const [optionDialogOpen, setOptionDialogOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ShopifyProduct | null>(null);

  // Filter and sort state
  const [sortOption, setSortOption] = useState<SortOption>("default");
  const [filters, setFilters] = useState<FilterState>({
    priceRange: [0, DEFAULT_MAX_PRICE],
    availability: "all",
  });

  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  // Extract discount % from collection handle (e.g. "初夏アイテム-15-off" → 15)
  const collectionDiscountPct = useMemo(() => {
    if (!collectionHandle) return 0;
    const match = collectionHandle.match(/-(\d+)-off/i);
    return match ? parseInt(match[1], 10) : 0;
  }, [collectionHandle]);

  // Calculate max price from products
  const maxPrice = useMemo(() => {
    if (allProducts.length === 0) return DEFAULT_MAX_PRICE;
    const prices = allProducts.map(p => parseFloat(p.node.priceRange.minVariantPrice.amount));
    return Math.max(...prices, DEFAULT_MAX_PRICE);
  }, [allProducts]);

  // Reset filters when max price changes
  useEffect(() => {
    setFilters(prev => ({
      ...prev,
      priceRange: [0, maxPrice],
    }));
  }, [maxPrice]);

  // Apply filters and sorting to products
  const filteredAndSortedProducts = useMemo(() => {
    let result = [...allProducts];

    // 품절 상품 제거
    result = result.filter(product =>
      product.node.variants.edges.some(v => v.node.availableForSale)
    );

    // Apply price filter
    result = result.filter(product => {
      const price = parseFloat(product.node.priceRange.minVariantPrice.amount);
      return price >= filters.priceRange[0] && price <= filters.priceRange[1];
    });

    // Apply sorting
    switch (sortOption) {
      case "price-asc":
        result.sort((a, b) =>
          parseFloat(a.node.priceRange.minVariantPrice.amount) -
          parseFloat(b.node.priceRange.minVariantPrice.amount)
        );
        break;
      case "price-desc":
        result.sort((a, b) =>
          parseFloat(b.node.priceRange.minVariantPrice.amount) -
          parseFloat(a.node.priceRange.minVariantPrice.amount)
        );
        break;
      case "title-asc":
        result.sort((a, b) => a.node.title.localeCompare(b.node.title));
        break;
      case "title-desc":
        result.sort((a, b) => b.node.title.localeCompare(a.node.title));
        break;
      default:
        break;
    }

    return result;
  }, [allProducts, sortOption, filters]);

  // GA4: view_item_list — fire once per search/collection change
  useEffect(() => {
    if (!loading && filteredAndSortedProducts.length > 0 && totalProductCount === null) {
      setTotalProductCount(filteredAndSortedProducts.length);
      const ga4Items = filteredAndSortedProducts.slice(0, 20).map(p =>
        shopifyToGA4Item(p.node, p.node.variants.edges[0]?.node)
      );
      trackViewItemList(ga4Items, 'All Products');
    }
  }, [loading, totalProductCount, filteredAndSortedProducts]);

  // 상품 목록이 바뀌면 Shopify Cart API로 자동 할인율을 상품별 개별 카트로 조회 (결과는 store에 캐시)
  useEffect(() => {
    if (allProducts.length === 0) return;
    const reps: { productId: string; variantId: string }[] = [];
    allProducts.forEach(p => {
      const v = (p.node.variants.edges.find(e => e.node.availableForSale) ?? p.node.variants.edges[0])?.node;
      if (v) reps.push({ productId: p.node.id, variantId: v.id });
    });
    fetchProductDiscounts(reps).then(map => {
      if (Object.keys(map).length === 0) return;
      setProductDiscounts(map);
    });
  }, [allProducts]);

  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.priceRange[0] > 0 || filters.priceRange[1] < maxPrice) count++;
    if (filters.availability !== "all") count++;
    return count;
  }, [filters, maxPrice]);

  const handleProductClick = (numericId: string, title?: string, price?: number) => {
    track('product_click', { product_id: numericId, product_title: title, price, collection: collectionHandle ?? undefined });
    saveScrollPosition(location.pathname);
    navigate(`/product/${numericId}`);
  };

  const getQuery = useCallback(() => {
    if (searchQuery) {
      const sanitized = searchQuery.replace(/[\\"`${}]/g, '');
      return sanitized;
    }
    return undefined;
  }, [searchQuery]);

  // Reset filters and sort when search or collection changes
  useEffect(() => {
    setSortOption(initialSort ?? "default");
    setFilters({
      priceRange: [0, DEFAULT_MAX_PRICE],
      availability: "all",
    });
  }, [searchQuery, collectionHandle, initialSort]);

  // Initial load
  useEffect(() => {
    const loadProducts = async () => {
      setLoading(true);
      setAllProducts([]);
      setEndCursor(null);
      setHasNextPage(false);
      setTotalProductCount(null);

      try {
        let response;
        if (collectionHandle) {
          response = await fetchCollectionProducts(collectionHandle, PRODUCTS_PER_PAGE);
          setCollectionTitle(response.collectionTitle);
        } else if (initialSort === 'best_selling') {
          const products = await fetchBestSellingProducts(50);
          setAllProducts(products);
          setHasNextPage(false);
          setEndCursor(null);
          return;
        } else if (initialSort === 'created_at_desc') {
          const products = await fetchNewProducts(50);
          setAllProducts(products);
          setHasNextPage(false);
          setEndCursor(null);
          return;
        } else {
          response = await fetchProducts(PRODUCTS_PER_PAGE, getQuery(), undefined);
        }
        setAllProducts(response.products);
        setHasNextPage(response.pageInfo.hasNextPage);
        setEndCursor(response.pageInfo.endCursor);
      } catch (error) {
        console.error('Failed to fetch products:', error);
      } finally {
        setLoading(false);
      }
    };
    loadProducts();
  }, [searchQuery, collectionHandle, initialSort, getQuery]);

  // Load more products
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasNextPage || !endCursor) return;

    setLoadingMore(true);
    try {
      let response;
      if (collectionHandle) {
        response = await fetchCollectionProducts(collectionHandle, PRODUCTS_PER_PAGE, endCursor);
      } else {
        const query = getQuery();
        response = await fetchProducts(PRODUCTS_PER_PAGE, query, endCursor);
      }
      setAllProducts(prev => [...prev, ...response.products]);
      setHasNextPage(response.pageInfo.hasNextPage);
      setEndCursor(response.pageInfo.endCursor);
    } catch (error) {
      console.error('Failed to load more products:', error);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasNextPage, endCursor, collectionHandle, getQuery]);

  // Intersection Observer for infinite scroll
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !loadingMore) {
          loadMore();
        }
      },
      { threshold: 0.1, rootMargin: '100px' }
    );

    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasNextPage, loadingMore, loadMore]);

  const handleAddToCart = (e: React.MouseEvent, product: ShopifyProduct) => {
    e.stopPropagation();
    setSelectedProduct(product);
    setOptionDialogOpen(true);
  };

  const getSearchText = () => `検索: "${searchQuery}"`;
  const getProductCountText = (count: number) => `${count} 商品`;
  const getNoSearchResultsText = () => '検索結果が見つかりません';
  const getTryDifferentSearchText = () => '別の検索語をお試しください。';
  const getNoFilterResultsText = () => 'フィルター条件に一致する商品がありません';

  const [collectionTitle, setCollectionTitle] = useState<string | null>(null);

  // Fetch collection title when collection changes
  useEffect(() => {
    if (!collectionHandle) {
      setCollectionTitle(null);
    }
  }, [collectionHandle]);

  const displayTitle = searchQuery
    ? getSearchText()
    : collectionTitle || (collectionHandle ? collectionHandle.replace(/-/g, ' ') : "ALL");

  if (loading) {
    return (
      <section className="py-8 px-4">
        <h2 className="text-2xl font-bold mb-4">{displayTitle}</h2>
        <div className="flex items-center gap-2 mb-4">
          <Skeleton className="h-9 w-[140px]" />
          <Skeleton className="h-9 w-20" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <ProductSkeleton key={i} />
          ))}
        </div>
      </section>
    );
  }

  if (allProducts.length === 0) {
    return (
      <section className="py-8 px-4">
        <h2 className="text-2xl font-bold mb-6">{displayTitle}</h2>
        <div className="bg-muted/50 rounded-xl p-12 text-center">
          <p className="text-muted-foreground text-lg mb-4">
            {collectionHandle && !searchQuery
              ? 'このカテゴリには商品がありません'
              : getNoSearchResultsText()}
          </p>
          <p className="text-sm text-muted-foreground">
            {collectionHandle && !searchQuery
              ? '他のカテゴリをお試しください。'
              : getTryDifferentSearchText()}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="py-8 px-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">{displayTitle}</h2>
        {filteredAndSortedProducts.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {filteredAndSortedProducts.length}{hasNextPage ? '+' : ''} 商品
          </span>
        )}
      </div>

      {/* Filters and Sort */}
      <ProductFilters
        sortOption={sortOption}
        onSortChange={setSortOption}
        filters={filters}
        onFiltersChange={setFilters}
        maxPrice={maxPrice}
        activeFilterCount={activeFilterCount}
      />

      {filteredAndSortedProducts.length === 0 ? (
        <div className="bg-muted/50 rounded-xl p-12 text-center">
          <p className="text-muted-foreground text-lg mb-4">
            {getNoFilterResultsText()}
          </p>
          <Button
            variant="outline"
            onClick={() => setFilters({ priceRange: [0, maxPrice], availability: "all" })}
          >
            {t('filters.clearFilters')}
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredAndSortedProducts.map((product) => {
              const image = product.node.images.edges[0]?.node;
              const price = product.node.priceRange.minVariantPrice;
              const isCompletelyOutOfStock = !product.node.variants.edges.some(v => v.node.availableForSale);

              return (
                <div
                  key={product.node.id}
                  className="bg-card rounded-xl overflow-hidden border border-border hover:shadow-lg transition-shadow cursor-pointer group"
                  onClick={() => handleProductClick(product.node.id.split('/').pop()!, product.node.title, parseFloat(product.node.priceRange.minVariantPrice.amount))}
                >
                  <div className="aspect-square bg-muted relative overflow-hidden">
                    {image ? (
                      <img
                        src={image.url}
                        alt={image.altText || product.node.title}
                        className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ${isCompletelyOutOfStock ? 'opacity-50' : ''}`}
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                        No Image
                      </div>
                    )}
                    {/* Favorite Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const node = product.node;
                        const price = node.priceRange?.minVariantPrice;
                        toggleWishlist({
                          productId: node.id,
                          handle: node.handle,
                          title: node.title,
                          imageUrl: node.images?.edges?.[0]?.node?.url,
                          price: price?.amount ?? '0',
                          currencyCode: price?.currencyCode ?? 'JPY',
                        });
                      }}
                      className="absolute top-2 right-2 w-8 h-8 rounded-full bg-background/70 backdrop-blur-sm flex items-center justify-center hover:bg-background/90 transition-colors z-10"
                    >
                      <Heart
                        className={`h-4 w-4 ${isWishlisted(product.node.id) ? 'fill-red-500 text-red-500' : 'text-muted-foreground'}`}
                      />
                    </button>
                    {/* Sold Out Overlay */}
                    {isCompletelyOutOfStock && (
                      <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                        <span className="bg-foreground text-background px-4 py-2 text-sm font-bold uppercase tracking-wider">
                          Sold Out
                        </span>
                      </div>
                    )}
                    {/* 割引率バッジ */}
                    {!isCompletelyOutOfStock && (() => {
                      const pctFromDiscount = discountMap[product.node.id] ?? 0;
                      const saleVariant = product.node.variants.edges.find(e => {
                        const ca = e.node.compareAtPrice;
                        return ca && parseFloat(ca.amount) > parseFloat(e.node.price.amount);
                      });
                      const pct = pctFromDiscount || (saleVariant
                        ? Math.round((1 - parseFloat(saleVariant.node.price.amount) / parseFloat(saleVariant.node.compareAtPrice!.amount)) * 100)
                        : collectionDiscountPct);
                      if (!pct) return null;
                      return (
                        <div className="absolute top-2 left-2 bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                          -{pct}%
                        </div>
                      );
                    })()}
                    {/* 予約配送バッジ */}
                    {!isCompletelyOutOfStock && getPreorderDate(product.node.tags ?? []) && (
                      <div className="absolute top-2 left-2 bg-amber-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                        予約
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <h3 className="font-medium text-sm line-clamp-2 mb-1 group-hover:text-primary transition-colors">
                      {product.node.title}
                    </h3>
                    <div
                      className="jdgm-widget jdgm-preview-badge mb-2"
                      data-id={product.node.id?.split('/').pop()}
                      data-handle={product.node.handle}
                    />
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        {(() => {
                          const pct = (discountMap[product.node.id] ?? 0) || collectionDiscountPct;
                          const originalAmt = parseFloat(price.amount);
                          const saleVariant = product.node.variants.edges.find(e => {
                            const ca = e.node.compareAtPrice;
                            return ca && parseFloat(ca.amount) > parseFloat(e.node.price.amount);
                          });
                          if (pct) {
                            const discounted = originalAmt * (1 - pct / 100);
                            return (
                              <div>
                                <span className="font-bold text-sm text-red-500" translate="no">
                                  {formatPrice(discounted.toFixed(0), price.currencyCode)}
                                </span>
                                <span className="ml-1 text-[10px] text-muted-foreground line-through" translate="no">
                                  {formatPrice(price.amount, price.currencyCode)}
                                </span>
                              </div>
                            );
                          } else if (saleVariant) {
                            return (
                              <div>
                                <span className="font-bold text-sm text-red-500" translate="no">
                                  {formatPrice(saleVariant.node.price.amount, saleVariant.node.price.currencyCode)}
                                </span>
                                <span className="ml-1 text-[10px] text-muted-foreground line-through" translate="no">
                                  {formatPrice(saleVariant.node.compareAtPrice!.amount, saleVariant.node.compareAtPrice!.currencyCode)}
                                </span>
                              </div>
                            );
                          }
                          return (
                            <span className={`font-bold text-sm ${isCompletelyOutOfStock ? 'text-muted-foreground' : 'text-primary'}`} translate="no">
                              {formatPrice(price.amount, price.currencyCode)}
                            </span>
                          );
                        })()}
                        {(() => {
                          const preorderDate = getPreorderDate(product.node.tags ?? []);
                          if (!preorderDate) return null;
                          const [y, m, d] = preorderDate.split('-');
                          return (
                            <p className="text-[10px] text-amber-600 mt-0.5">{y}/{m}/{d} 発送予定</p>
                          );
                        })()}
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={(e) => handleAddToCart(e, product)}
                        className="h-8 w-8 p-0 flex-shrink-0"
                        disabled={isCompletelyOutOfStock}
                      >
                        <ShoppingCart className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Infinite scroll trigger */}
          <div ref={loadMoreRef} className="h-20 flex items-center justify-center">
            {loadingMore && (
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            )}
          </div>

          {/* Product Option Dialog */}
          <ProductOptionDialog
            product={selectedProduct}
            open={optionDialogOpen}
            onOpenChange={setOptionDialogOpen}
          />
        </>
      )}
    </section>
  );
};
