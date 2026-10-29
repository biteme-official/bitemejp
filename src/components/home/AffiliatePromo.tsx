import { useNavigate } from "react-router-dom";
import { PartyPopper, ChevronRight } from "lucide-react";
import { track } from "@/lib/track";

export function AffiliatePromo() {
  const navigate = useNavigate();

  return (
    <section className="px-4 mt-3 md:mt-6">
      <button
        onClick={() => {
          // 어드민 「사이트 성과」 메인 화면 구좌 집계용 (#264)
          track("promo_click", { slot: "affiliate", target: "/affiliate" });
          navigate("/affiliate");
        }}
        className="w-full text-left rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 md:px-5 md:py-4 shadow-sm hover:opacity-95 transition-opacity"
        aria-label="アフィリエイト募集ページへ"
      >
        <div className="flex items-center gap-3 md:gap-4">
          <div className="shrink-0 h-9 w-9 md:h-12 md:w-12 rounded-full bg-white/20 flex items-center justify-center">
            <PartyPopper className="h-5 w-5 md:h-6 md:w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="inline-block rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold">
              オープン記念キャンペーン
            </span>
            <p className="mt-0.5 md:mt-1 text-sm font-bold leading-snug">
              {/* 모바일에서 「コミッショ / ン率 10%」 로 어절 중간이 갈리던 것 — 뒷 어절은 한 덩어리로 */}
              アフィリエイト募集｜<span className="whitespace-nowrap">コミッション率 <span className="text-lg">10%</span></span>
            </p>
            {/* 모바일은 첫 화면에 상품이 보이도록 설명 줄을 숨겨 낮춘다 (2026-10-29) */}
            <p className="hidden md:block text-xs text-primary-foreground/80 mt-0.5 truncate">
              Instagramで商品を紹介して、一緒に魅力を届けませんか？
            </p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-primary-foreground/80" />
        </div>
      </button>
    </section>
  );
}
