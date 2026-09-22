import { HomeBanner, HomeBannersSettings, hasText } from "@/lib/homeBanners";
import { cn } from "@/lib/utils";

/**
 * 메인 배너 한 장 (#194). 메인 캐러셀과 어드민 미리보기가 같은 컴포넌트를 쓴다 — 어드민에서 본 그대로 나간다.
 *
 * 글자 크기는 뷰포트(vw)가 아니라 **배너 폭(cqw)** 에 비례한다. 그래야 어드민 미리보기(폭 300~700px)와
 * 실제 화면이 같은 비율로 그려진다. 바깥 div 에 `container-type: inline-size` 를 건다.
 *
 * 자리는 고정이다(하영 2026-09-22): 배지·부제·헤드라인은 위 기준선에서 아래로 쌓이고, CTA 는 아래 기준선에
 * 붙는다. 헤드라인이 한 줄이든 세 줄이든 CTA 자리는 안 움직인다.
 *
 * 모바일 틀(settings.mobileRatio):
 *  - strip : PC 이미지(1200×504) 그대로. 문구는 왼쪽 52% 안에만
 *  - 4:3 / 1:1 : 세로가 있는 틀. 모바일 이미지가 있으면 꽉 채우고, 없으면 배경색 위에 PC 이미지를
 *    아래쪽에 가로형 그대로 깔고 위 띠에 문구를 쓴다(문구가 없는 이미지 배너는 가운데 정렬).
 */
interface BannerSlideProps {
  banner: HomeBanner;
  settings: HomeBannersSettings;
  device: "pc" | "mobile";
  className?: string;
}

/** 자리·크기 세트. 퍼센트는 틀 기준, 글자는 cqw(배너 폭 1% 단위) */
interface Layout {
  aspect: string;
  left: string;
  width: string;
  top: string;
  bottom: string;
  badge: string;
  subtext: string;
  headline: string;
  cta: string;
  gap: string;
}

const PC: Layout = {
  aspect: "1200 / 504",
  left: "6%",
  width: "50%",
  top: "20%",
  bottom: "16%",
  badge: "clamp(9px, 1.1cqw, 14px)",
  subtext: "clamp(11px, 2.6cqw, 34px)",
  headline: "clamp(15px, 5cqw, 62px)",
  cta: "clamp(10px, 2.1cqw, 26px)",
  gap: "1.2cqw",
};

// 가로형은 높이가 화면 폭의 42% 뿐이라 빡빡하다 — 헤드라인 3줄 + CTA 까지 겨우 들어가는 크기
const MOBILE_STRIP: Layout = {
  aspect: "1200 / 504",
  left: "4%",
  width: "55%",
  top: "8%",
  bottom: "11%",
  badge: "2.6cqw",
  subtext: "3.2cqw",
  headline: "5cqw",
  cta: "3.2cqw",
  gap: "1.2cqw",
};

const MOBILE_TALL: Layout = {
  aspect: "4 / 3",
  left: "5%",
  width: "90%",
  top: "6%",
  bottom: "7%",
  badge: "2.8cqw",
  subtext: "3.6cqw",
  headline: "6.5cqw",
  cta: "3.4cqw",
  gap: "1.8cqw",
};

function layoutFor(device: "pc" | "mobile", settings: HomeBannersSettings): Layout {
  if (device === "pc") return PC;
  if (settings.mobileRatio === "strip") return MOBILE_STRIP;
  return { ...MOBILE_TALL, aspect: settings.mobileRatio === "1:1" ? "1 / 1" : "4 / 3" };
}

function TextLayer({ banner, layout }: { banner: HomeBanner; layout: Layout }) {
  const t = banner.text;
  const light = t.tone === "light";
  const color = light ? "text-white" : "text-neutral-900";
  return (
    <div
      className={cn("absolute inset-y-0 pointer-events-none", color)}
      style={{ left: layout.left, width: layout.width }}
    >
      {/* 위 기준선에서 아래로 */}
      <div className="absolute inset-x-0 flex flex-col items-start" style={{ top: layout.top }}>
        {t.badge && (
          <span
            className="mb-[0.8em] px-[0.9em] py-[0.25em] rounded-full bg-primary text-primary-foreground font-bold tracking-wider leading-none"
            style={{ fontSize: layout.badge }}
          >
            {t.badge}
          </span>
        )}
        {t.subtext && (
          <p className="font-medium leading-snug whitespace-pre-line" style={{ fontSize: layout.subtext }}>
            {t.subtext}
          </p>
        )}
        {t.headline && (
          <p
            className="font-black leading-[1.25] whitespace-pre-line [word-break:auto-phrase]"
            style={{ fontSize: layout.headline, marginTop: t.subtext ? layout.gap : 0 }}
          >
            {t.headline}
          </p>
        )}
      </div>
      {/* 아래 기준선 — 헤드라인 길이와 무관하게 늘 여기 */}
      {t.cta && (
        <div className="absolute inset-x-0 flex" style={{ bottom: layout.bottom }}>
          {t.ctaStyle === "button" ? (
            <span
              className="inline-block rounded-full bg-primary text-primary-foreground font-bold px-[1.4em] py-[0.55em] leading-none"
              style={{ fontSize: layout.cta }}
            >
              {t.cta}
            </span>
          ) : (
            <span className="font-medium" style={{ fontSize: layout.cta }}>
              {t.cta}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function BannerSlide({ banner, settings, device, className }: BannerSlideProps) {
  const layout = layoutFor(device, settings);
  const withText = hasText(banner.text);
  const alt = banner.text.headline || banner.name || "Banner";
  const tall = device === "mobile" && settings.mobileRatio !== "strip";
  const image = device === "mobile" && banner.mobileImage ? banner.mobileImage : banner.pcImage;

  return (
    <div
      className={cn("relative w-full overflow-hidden", className)}
      style={{ containerType: "inline-size", background: banner.bg }}
    >
      <div className="relative w-full" style={{ aspectRatio: layout.aspect }}>
        {image && (tall && !banner.mobileImage ? (
          // 세로 틀인데 모바일 이미지가 없다 — PC 이미지를 가로형 그대로. 문구가 있으면 아래, 없으면 가운데
          <img
            src={image}
            alt={alt}
            draggable={false}
            className={cn("absolute inset-x-0 w-full h-auto", withText ? "bottom-0" : "top-1/2 -translate-y-1/2")}
          />
        ) : (
          <img src={image} alt={alt} draggable={false} className="absolute inset-0 w-full h-full object-cover" />
        ))}
        {withText && <TextLayer banner={banner} layout={layout} />}
      </div>
    </div>
  );
}
