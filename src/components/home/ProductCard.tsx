import { Heart, ShoppingCart } from "lucide-react";
import { ShopifyProduct, formatPrice, getPreorderDate } from "@/lib/shopify";
import { useWishlistStore } from "@/stores/wishlistStore";
import { cn } from "@/lib/utils";

/**
 * 메인 섹션(新商品·人気商品·특집)이 공통으로 쓰는 상품 카드 (#185).
 *
 * 참고 시안 그대로 — 왼쪽 위 섹션 배지, 오른쪽 위 찜 하트, 이미지, 상품명 2줄,
 * 가격 + 장바구니 버튼 한 줄. 할인·예약 배지는 기존 섹션들의 규칙을 그대로 옮겼다.
 * 시안의 리뷰 별점은 넣지 않았다 — 리뷰 API 가 상품 1건씩이라 메인에서 30건을 따로 부르게 된다.
 * (기존 jdgm-preview-badge div 는 스크립트가 없어 한 번도 그려진 적이 없어 함께 뺐다)
 *
 * 할인율 우선순위: Cart API 자동할인(discountPct) > 컬렉션 핸들의 "-NN-off" > compareAtPrice.
 */
export interface ProductBadge {
  label: string;
  /** Tailwind 배경/글자색. 기본은 브랜드 오렌지 */
  className?: string;
}

interface ProductCardProps {
  product: ShopifyProduct;
  badge?: ProductBadge;
  /** Cart API 로 조회한 자동 할인율(%) */
  discountPct?: number;
  /** 컬렉션 핸들에서 뽑은 할인율(%) */
  collectionDiscountPct?: number;
  onClick: (product: ShopifyProduct) => void;
  onAddToCart: (product: ShopifyProduct) => void;
  className?: string;
}

/** 표시할 최종가/정가 계산. 정가가 없으면 `original` 은 null */
function resolvePrice(product: ShopifyProduct, discountPct: number, collectionDiscountPct: number) {
  const node = product.node;
  const price = node.priceRange.minVariantPrice;
  const originalAmt = parseFloat(price.amount);
  const rep = (node.variants.edges.find(e => e.node.availableForSale) ?? node.variants.edges[0])?.node;
  const compareAt = rep?.compareAtPrice;

  const pct = discountPct || collectionDiscountPct;
  if (pct) {
    return {
      pct,
      final: formatPrice((originalAmt * (1 - pct / 100)).toFixed(0), price.currencyCode),
      original: formatPrice(price.amount, price.currencyCode),
    };
  }
  if (compareAt && parseFloat(compareAt.amount) > originalAmt) {
    return {
      pct: Math.round((1 - originalAmt / parseFloat(compareAt.amount)) * 100),
      final: formatPrice(price.amount, price.currencyCode),
      original: formatPrice(compareAt.amount, compareAt.currencyCode),
    };
  }
  return { pct: 0, final: formatPrice(price.amount, price.currencyCode), original: null };
}

export function ProductCard({
  product,
  badge,
  discountPct = 0,
  collectionDiscountPct = 0,
  onClick,
  onAddToCart,
  className,
}: ProductCardProps) {
  const { isWishlisted, toggleItem } = useWishlistStore();
  const node = product.node;
  const image = node.images.edges[0]?.node;
  const isAvailable = node.variants.edges.some(v => v.node.availableForSale);
  const preorderDate = getPreorderDate(node.tags ?? []);
  const { pct, final, original } = resolvePrice(product, discountPct, collectionDiscountPct);
  const wishlisted = isWishlisted(node.id);

  return (
    <div
      onClick={() => onClick(product)}
      className={cn(
        "group bg-card rounded-xl border border-border overflow-hidden shadow-sm hover:shadow-card hover:-translate-y-0.5 transition-all cursor-pointer",
        className,
      )}
    >
      <div className="aspect-square bg-secondary relative overflow-hidden">
        {image ? (
          <img
            src={image.url}
            alt={image.altText || node.title}
            className={cn(
              "w-full h-full object-cover group-hover:scale-105 transition-transform duration-300",
              !isAvailable && "opacity-50",
            )}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
            No Image
          </div>
        )}

        {/* 왼쪽 위: 섹션 배지 → 예약 → 할인 순으로 쌓는다 */}
        <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
          {badge && (
            <span
              className={cn(
                "text-[10px] font-bold px-1.5 py-0.5 rounded-md tracking-wide",
                badge.className ?? "bg-primary text-primary-foreground",
              )}
            >
              {badge.label}
            </span>
          )}
          {isAvailable && preorderDate && (
            <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
              予約
            </span>
          )}
          {isAvailable && pct > 0 && (
            <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
              -{pct}%
            </span>
          )}
        </div>

        {/* 오른쪽 위: 찜 */}
        <button
          type="button"
          aria-label={wishlisted ? "お気に入りから削除" : "お気に入りに追加"}
          onClick={(e) => {
            e.stopPropagation();
            toggleItem({
              productId: node.id,
              handle: node.handle,
              title: node.title,
              imageUrl: image?.url,
              price: node.priceRange.minVariantPrice.amount,
              currencyCode: node.priceRange.minVariantPrice.currencyCode,
            });
          }}
          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-background/70 backdrop-blur-sm flex items-center justify-center hover:bg-background/90 transition-colors z-10"
        >
          <Heart className={cn("h-3.5 w-3.5", wishlisted ? "fill-red-500 text-red-500" : "text-muted-foreground")} />
        </button>

        {!isAvailable && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="bg-foreground/80 text-background text-[10px] font-bold px-2 py-0.5 rounded">
              Sold Out
            </span>
          </div>
        )}
      </div>

      <div className="p-2.5 md:p-3">
        <h3 className="text-[11px] md:text-xs font-medium text-foreground line-clamp-2 mb-1.5 min-h-[30px] md:min-h-[32px]">
          {node.title}
        </h3>
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            {original ? (
              <div>
                <span className="text-xs md:text-sm font-bold text-red-500" translate="no">{final}</span>
                <span className="ml-1 text-[10px] text-muted-foreground line-through" translate="no">{original}</span>
              </div>
            ) : (
              <p className="text-xs md:text-sm font-bold text-primary" translate="no">{final}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="カートに追加"
            disabled={!isAvailable}
            onClick={(e) => { e.stopPropagation(); onAddToCart(product); }}
            className="shrink-0 w-7 h-7 rounded-full bg-foreground text-background flex items-center justify-center hover:bg-primary transition-colors disabled:opacity-40 disabled:hover:bg-foreground"
          >
            <ShoppingCart className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
