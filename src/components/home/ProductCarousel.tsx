import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ShopifyProduct } from "@/lib/shopify";
import { ProductOptionDialog } from "@/components/shop/ProductOptionDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";
import { ProductBadge, ProductCard } from "./ProductCard";

/**
 * 메인 섹션 공통 캐러셀 (#185) — 가운데 정렬 제목 + 가로 스크롤 카드 + PC 좌우 화살표.
 *
 * 화살표는 넘칠 때만 보이고, 양 끝에 닿으면 그쪽 화살표가 사라진다.
 * 모바일은 손가락 스크롤이 자연스러워 화살표를 감춘다(md 이상에서만 표시).
 * 카드의 장바구니 버튼은 하단 ALL 그리드와 같은 옵션 다이얼로그를 띄운다.
 */
interface ProductCarouselProps {
  title: string;
  products: ShopifyProduct[];
  badge?: ProductBadge;
  /** 상품별 Cart API 자동 할인율 */
  discountMap?: Record<string, number>;
  collectionDiscountPct?: number;
  moreLabel?: string;
  onMore?: () => void;
  /** 클릭 트래킹용 섹션 식별자 */
  trackName?: string;
  className?: string;
  style?: React.CSSProperties;
}

/** 카드 폭·간격과 맞춘 스켈레톤 */
export function ProductCarouselSkeleton() {
  return (
    <section className="pb-4">
      <div className="flex justify-center mb-4">
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="flex gap-3 md:gap-4 px-4 overflow-hidden">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-shrink-0 w-40 md:w-52 bg-card rounded-xl border border-border overflow-hidden">
            <Skeleton className="aspect-square w-full" />
            <div className="p-3 space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-4 w-14" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProductCarousel({
  title,
  products,
  badge,
  discountMap = {},
  collectionDiscountPct = 0,
  moreLabel = "すべて見る",
  onMore,
  trackName,
  className,
  style,
}: ProductCarouselProps) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<ShopifyProduct | null>(null);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanPrev(el.scrollLeft > 4);
    setCanNext(el.scrollLeft < max - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateArrows, { passive: true });
    window.addEventListener("resize", updateArrows);
    return () => {
      el.removeEventListener("scroll", updateArrows);
      window.removeEventListener("resize", updateArrows);
    };
  }, [updateArrows, products.length]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  const handleClick = (product: ShopifyProduct) => {
    const numericId = product.node.id.split("/").pop()!;
    track("product_click", {
      product_id: numericId,
      product_title: product.node.title,
      price: parseFloat(product.node.priceRange.minVariantPrice.amount),
      collection: trackName,
    });
    navigate(`/product/${numericId}`);
  };

  if (products.length === 0) return null;

  return (
    <section className={cn("pb-4 animate-fade-up", className)} style={style}>
      {/* 제목은 PC 에서 가운데, 모바일은 긴 제목이 더보기와 겹치지 않게 왼쪽 정렬 */}
      <div className="relative flex items-center justify-between md:justify-center gap-3 px-4 mb-4">
        <h2 className="text-lg md:text-xl font-bold text-foreground text-left md:text-center break-keep">{title}</h2>
        {onMore && (
          <button
            onClick={onMore}
            className="shrink-0 md:absolute md:right-4 flex items-center gap-0.5 text-xs md:text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {moreLabel}
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="relative">
        <div
          ref={scrollRef}
          className="flex gap-3 md:gap-4 px-4 overflow-x-auto pb-2 scrollbar-hide scroll-smooth"
        >
          {products.map((product) => (
            <ProductCard
              key={product.node.id}
              product={product}
              badge={badge}
              discountPct={discountMap[product.node.id] ?? 0}
              collectionDiscountPct={collectionDiscountPct}
              onClick={handleClick}
              onAddToCart={(p) => { setSelected(p); setDialogOpen(true); }}
              className="flex-shrink-0 w-40 md:w-52"
            />
          ))}
        </div>

        {canPrev && (
          <button
            type="button"
            aria-label="前へ"
            onClick={() => scrollBy(-1)}
            className="hidden md:flex absolute left-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-background/90 border border-border shadow-md items-center justify-center hover:bg-background transition-colors z-10"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {canNext && (
          <button
            type="button"
            aria-label="次へ"
            onClick={() => scrollBy(1)}
            className="hidden md:flex absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-background/90 border border-border shadow-md items-center justify-center hover:bg-background transition-colors z-10"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>

      <ProductOptionDialog product={selected} open={dialogOpen} onOpenChange={setDialogOpen} />
    </section>
  );
}
