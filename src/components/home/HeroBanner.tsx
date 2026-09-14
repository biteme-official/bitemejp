import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { fetchBanners, ShopifyBanner } from "@/lib/shopify";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { track } from "@/lib/track";

/**
 * 배지 드롭다운 값 → 화면 표기. 목록에 없는 값은 대문자로 그대로 보여준다(어드민에서 선택지를 늘려도 동작).
 */
const BADGE_LABELS: Record<string, string> = {
  new: "NEW",
  "best-seller": "BEST SELLER",
  bestseller: "BEST SELLER",
  best: "BEST SELLER",
  sale: "SALE",
  limited: "LIMITED",
  restock: "RESTOCK",
};

function badgeLabel(raw: string): string {
  return BADGE_LABELS[raw.trim().toLowerCase()] ?? raw.trim().toUpperCase();
}

/**
 * 이미지 위에 얹는 문구 (#174). 어드민 메타오브젝트의 Badge·Headline·Subtext·Button Label 을 그대로 그린다.
 * 셋 다 비어 있으면 아무것도 그리지 않아, 문구를 이미지에 박아 만든 기존 배너는 지금과 똑같이 보인다.
 *
 * 배너 전체가 이미 클릭 영역이라 버튼은 별도 링크가 아니라 시각적 CTA 다(중첩 a/button 을 피한다).
 * 사진 위 글자라 배경색을 모르므로 왼쪽→오른쪽 어두운 그라데이션으로 대비를 만든다.
 */
function BannerText({ text }: { text: ShopifyBanner["text"] }) {
  const { badge, headline, subtext, buttonLabel } = text;
  if (!headline && !subtext && !buttonLabel) return null;

  return (
    <div className="absolute inset-0 flex items-center bg-gradient-to-r from-black/55 via-black/25 to-transparent pointer-events-none">
      {/* 좌우 화살표(left-2 + w-8 = 40px)와 겹치지 않도록 모바일도 왼쪽 여백을 48px 이상 둔다 */}
      <div className="px-12 md:px-14 max-w-[80%] sm:max-w-[55%] text-white drop-shadow-md">
        {badge && (
          <span className="inline-block mb-2 sm:mb-3 px-2 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] sm:text-xs font-bold tracking-wider">
            {badgeLabel(badge)}
          </span>
        )}
        {headline && (
          <p className="font-bold leading-tight text-lg sm:text-3xl md:text-4xl break-keep">
            {headline}
          </p>
        )}
        {subtext && (
          <p className="mt-1 sm:mt-2 text-xs sm:text-base md:text-lg leading-snug whitespace-pre-line line-clamp-2 sm:line-clamp-3">
            {subtext}
          </p>
        )}
        {buttonLabel && (
          <span className="inline-block mt-3 sm:mt-5 px-4 py-1.5 sm:px-6 sm:py-2.5 rounded-full bg-white text-black text-xs sm:text-sm font-semibold">
            {buttonLabel}
          </span>
        )}
      </div>
    </div>
  );
}

export function HeroBanner() {
  const [banners, setBanners] = useState<ShopifyBanner[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bannersLengthRef = useRef(0);

  useEffect(() => {
    fetchBanners(25)
      .then((data) => {
        setBanners(data.filter((b) => b.image));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    bannersLengthRef.current = banners.length;
  }, [banners.length]);

  const startTimer = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (bannersLengthRef.current <= 1) return;
    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % bannersLengthRef.current);
    }, 5000);
  }, []);

  // Auto-slide
  useEffect(() => {
    if (banners.length <= 1) return;
    startTimer();
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [banners.length, startTimer]);

  const goTo = useCallback(
    (index: number) => {
      const len = bannersLengthRef.current;
      setCurrentIndex(((index % len) + len) % len);
      startTimer();
    },
    [startTimer]
  );

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => {
      const len = bannersLengthRef.current;
      return ((prev - 1) + len) % len;
    });
    startTimer();
  }, [startTimer]);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % bannersLengthRef.current);
    startTimer();
  }, [startTimer]);

  if (loading) {
    return (
      <div className="w-full">
        <Skeleton className="w-full aspect-[21/9]" />
      </div>
    );
  }

  if (banners.length === 0) return null;

  return (
    <div className="relative w-full overflow-hidden bg-secondary">
      {/* Slides */}
      <div
        className="flex transition-transform duration-500 ease-in-out"
        style={{ transform: `translateX(-${currentIndex * 100}%)` }}
      >
        {banners.map((banner) => (
          <div
            key={banner.id}
            className="relative w-full flex-shrink-0"
            onClick={() => {
              track('banner_click', { banner_title: banner.text.headline || banner.fields['title'] || banner.handle, banner_id: banner.id, position: currentIndex });
              if (banner.linkUrl) window.location.href = banner.linkUrl;
            }}
            style={{ cursor: banner.linkUrl ? 'pointer' : 'default' }}
          >
            <img
              src={banner.image!.url}
              alt={banner.image!.altText || banner.text.headline || "Banner"}
              className="w-full h-auto block"
            />
            <BannerText text={banner.text} />
          </div>
        ))}
      </div>

      {/* Navigation Arrows */}
      {banners.length > 1 && (
        <>
          <button
            onClick={goPrev}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/60 backdrop-blur-sm flex items-center justify-center hover:bg-background/80 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={goNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/60 backdrop-blur-sm flex items-center justify-center hover:bg-background/80 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      )}

      {/* Dots */}
      {banners.length > 1 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
          {banners.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={cn(
                "w-2 h-2 rounded-full transition-all",
                i === currentIndex
                  ? "bg-foreground w-4"
                  : "bg-foreground/40 hover:bg-foreground/60"
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
