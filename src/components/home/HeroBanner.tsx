import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { track } from "@/lib/track";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DEFAULT_SETTINGS,
  HomeBanner,
  HomeBannersSettings,
  fetchHomeBanners,
  importFromShopify,
  isHomeBannerLive,
} from "@/lib/homeBanners";
import { BannerSlide } from "./BannerSlide";

/**
 * 메인 배너 캐러셀.
 *
 * 데이터는 어드민 「메인 배너」 탭이 저장한 자체 문서(`/api/home-banners`)에서 온다(#194).
 * 문서가 아직 없으면 예전 Shopify 메타오브젝트(2603)를 같은 모양으로 바꿔 보여준다 —
 * 어드민에서 처음 저장하는 순간부터 자체 문서로 넘어가며, 그때부터 Shopify 쪽은 안 읽는다.
 *
 * 한 장의 그리기는 BannerSlide(어드민 미리보기와 같은 컴포넌트). 여기는 넘김(자동·화살표·점·스와이프)만.
 * 모바일은 화살표를 감추고 스와이프로 넘긴다 — 화살표가 이미지 왼쪽 글자를 가렸었다.
 */
export function HeroBanner() {
  const isMobile = useIsMobile();
  const [banners, setBanners] = useState<HomeBanner[]>([]);
  const [settings, setSettings] = useState<HomeBannersSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bannersLengthRef = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const src = await fetchHomeBanners();
        if (src.source === "doc") {
          if (cancelled) return;
          setSettings({ ...DEFAULT_SETTINGS, ...src.doc.settings });
          setBanners(src.doc.banners.filter((b) => isHomeBannerLive(b)));
          return;
        }
        // 자체 문서가 아직 없다 — Shopify 메타오브젝트 그대로(가로형 그대로, 예약 반영)
        const legacy = await importFromShopify();
        if (cancelled) return;
        setSettings({ mobileRatio: "strip" });
        setBanners(legacy.filter((b) => isHomeBannerLive(b)));
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
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

  // 모바일 스와이프. 가로 40px 이상 + 세로보다 가로가 큰 움직임만 넘김으로 본다(세로 스크롤 중 오작동 방지).
  // 손가락이 움직인 터치 뒤엔 브라우저가 click 을 안 내므로 <a> 슬라이드가 링크로 새지 않는다.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || bannersLengthRef.current <= 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) goNext();
    else goPrev();
  };

  if (loading) {
    return (
      <div className="w-full">
        <Skeleton className="w-full aspect-[21/9]" />
      </div>
    );
  }

  if (banners.length === 0) return null;

  const device = isMobile ? "mobile" : "pc";

  return (
    <div className="relative w-full overflow-hidden bg-secondary">
      {/* Slides */}
      <div
        className="flex transition-transform duration-500 ease-in-out"
        style={{ transform: `translateX(-${currentIndex * 100}%)` }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {banners.map((banner) => {
          const inner = <BannerSlide banner={banner} settings={settings} device={device} />;
          const onClick = () =>
            track('banner_click', { banner_title: banner.text.headline || banner.name, banner_id: banner.id, position: currentIndex });
          // 링크가 있으면 진짜 <a> — Ctrl+클릭 새 탭·링크 복사가 된다. 절대 URL 일 수 있어 Link 대신 a
          return banner.link ? (
            <a key={banner.id} href={banner.link} onClick={onClick} className="relative w-full flex-shrink-0 block">
              {inner}
            </a>
          ) : (
            <div key={banner.id} onClick={onClick} className="relative w-full flex-shrink-0">
              {inner}
            </div>
          );
        })}
      </div>

      {/* Navigation Arrows — 모바일은 스와이프로 넘기고 감춘다 */}
      {banners.length > 1 && (
        <>
          <button
            onClick={goPrev}
            aria-label="前へ"
            className="hidden md:flex absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/60 backdrop-blur-sm items-center justify-center hover:bg-background/80 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={goNext}
            aria-label="次へ"
            className="hidden md:flex absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/60 backdrop-blur-sm items-center justify-center hover:bg-background/80 transition-colors"
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
