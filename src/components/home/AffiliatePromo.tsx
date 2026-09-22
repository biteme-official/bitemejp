import { useNavigate } from "react-router-dom";
import { PartyPopper, ChevronRight } from "lucide-react";

export function AffiliatePromo() {
  const navigate = useNavigate();

  return (
    <section className="px-4 mt-6">
      <button
        onClick={() => navigate("/affiliate")}
        className="w-full text-left rounded-2xl bg-primary text-primary-foreground px-5 py-4 shadow-sm hover:opacity-95 transition-opacity"
        aria-label="アフィリエイト募集ページへ"
      >
        <div className="flex items-center gap-4">
          <div className="shrink-0 h-12 w-12 rounded-full bg-white/20 flex items-center justify-center">
            <PartyPopper className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="inline-block rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold">
              オープン記念キャンペーン
            </span>
            <p className="mt-1 text-sm font-bold leading-snug">
              {/* 모바일에서 「コミッショ / ン率 10%」 로 어절 중간이 갈리던 것 — 뒷 어절은 한 덩어리로 */}
              アフィリエイト募集｜<span className="whitespace-nowrap">コミッション率 <span className="text-lg">10%</span></span>
            </p>
            <p className="text-xs text-primary-foreground/80 mt-0.5 truncate">
              Instagramで商品を紹介して、一緒に魅力を届けませんか？
            </p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-primary-foreground/80" />
        </div>
      </button>
    </section>
  );
}
