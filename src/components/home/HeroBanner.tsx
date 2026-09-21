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
 * 레이아웃은 기존 제작 배너(1200×504, 왼쪽 6% 여백 · 위에 작은 한 줄 · 큰 헤드라인 2줄 · 아래 CTA 한 줄)를 따른다.
 * 딤(그라데이션)은 깔지 않는다 — 배경이 밝은 단색인 배너라 글자만 진하게 얹으면 된다. 따라서 이미지는 밝은 배경이어야 한다.
 * 글자 크기는 배너 폭에 비례(vw)하되 모바일에서 너무 작아지지 않게 clamp 로 하한을 둔다.
 *
 * 배너 전체가 이미 클릭 영역이라 CTA 는 별도 링크가 아니라 글자만(중첩 a/button 을 피한다).
 */
function BannerText({ text }: { text: ShopifyBanner["text"] }) {
  const { badge, headline, subtext, buttonLabel } = text;
  if (!headline && !subtext && !buttonLabel) return null;

  return (
    <div className="absolute inset-0 flex flex-col justify-center pl-[max(6%,3rem)] pr-[38%] text-neutral-900 pointer-events-none">
      {badge && (
        <span className="self-start mb-[1.2vw] px-[0.9em] py-[0.2em] rounded-full bg-primary text-primary-foreground font-bold tracking-wider text-[clamp(9px,1.1vw,14px)]">
          {badgeLabel(badge)}
        </span>
      )}
      {subtext && (
        <p className="font-medium leading-snug whitespace-pre-line line-clamp-2 text-[clamp(11px,2.6vw,34px)]">
          {subtext}
        </p>
      )}
      {headline && (
        <p className="mt-[1.2vw] font-black leading-[1.25] break-keep text-[clamp(15px,5vw,62px)]">
          {headline}
        </p>
      )}
      {buttonLabel && (
        <p className="mt-[clamp(10px,4.5vw,56px)] font-medium text-[clamp(10px,2.1vw,26px)]">
          {buttonLabel}
        </p>
      )}
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
        {banners.map((banner) => {
          const inner = (
            <>
              <img
                src={banner.image!.url}
                alt={banner.image!.altText || banner.text.headline || "Banner"}
                className="w-full h-auto block"
                draggable={false}
              />
              <BannerText text={banner.text} />
            </>
          );
          const onClick = () =>
            track('banner_click', { banner_title: banner.text.headline || banner.fields['title'] || banner.handle, banner_id: banner.id, position: currentIndex });
          // 링크가 있으면 진짜 <a> — Ctrl+클릭 새 탭·링크 복사가 된다. 절대 URL 일 수 있어 Link 대신 a
          return banner.linkUrl ? (
            <a key={banner.id} href={banner.linkUrl} onClick={onClick} className="relative w-full flex-shrink-0 block">
              {inner}
            </a>
          ) : (
            <div key={banner.id} className="relative w-full flex-shrink-0">
              {inner}
            </div>
          );
        })}
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
