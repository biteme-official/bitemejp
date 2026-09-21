/**
 * 상품 상세의 파트너 전용 박스 — 「この商品をシェアして、売上の10%をもらおう」 (#178, 하영 요청 2026-09-21)
 *
 * 파트너 페이지의 기본 링크는 홈으로 가지만, 인스타에 올리는 건 결국 특정 상품이다. 쿠팡 파트너스·지그재그처럼
 * 상품 페이지에서 바로 `biteme.co.jp/a/CODE?p=/product/ID` 를 받게 하고, 문구는 「행동 + 얻는 것」 한 줄로.
 * 요율은 기본 10% 이되, 이 파트너·이 상품에 적용 중인 캠페인이 있으면 그 요율(가장 높은 것)을 보여준다.
 *
 * 파트너 여부·캠페인은 세션 동안 한 번만 묻는다(sessionStorage) — 상품을 볼 때마다 API 를 부르지 않기 위해.
 * 파트너가 아니거나 비로그인이면 아무것도 그리지 않는다.
 */
import { useEffect, useState } from "react";
import { Copy, Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/authStore";
import { AffiliateApiError, fetchPartnerView } from "@/lib/affiliate-api";

const CACHE_KEY = "aff_partner_v2";
const BASE_RATE = 0.1;

interface Cached {
  t: string;
  code: string | null;
  campaigns: Array<{ scope: string; rate: number; targetIds: string[]; endsAt: string }>;
}

function readCache(token: string): Cached | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Cached;
    // 토큰이 바뀌었으면(재로그인) 캐시를 버린다
    return v.t === token.slice(-16) ? v : null;
  } catch { return null; }
}
function writeCache(token: string, code: string | null, campaigns: Cached["campaigns"]) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: token.slice(-16), code, campaigns } satisfies Cached)); } catch { /* 무시 */ }
}

/** 이 상품에 적용되는 요율 — 전원/지정 파트너 캠페인 또는 이 상품을 지정한 캠페인 중 최대, 없으면 기본 10% */
function rateFor(campaigns: Cached["campaigns"], productId: string): number {
  const now = Date.now();
  const rates = campaigns
    .filter((c) => new Date(c.endsAt).getTime() > now)
    .filter((c) => c.scope !== "products" || c.targetIds.includes(productId))
    .map((c) => c.rate);
  return Math.max(BASE_RATE, ...rates);
}

export function PartnerProductLink({ productNumericId }: { productNumericId: string | null }) {
  const token = useAuthStore((s) => s.user?.lineSessionToken);
  const [info, setInfo] = useState<Cached | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) { setInfo(null); return; }
    const cached = readCache(token);
    if (cached) { setInfo(cached); return; }
    let alive = true;
    fetchPartnerView(token)
      .then((v) => {
        if (!alive) return;
        const code = v.partner.status === "active" ? v.partner.code : null;
        const campaigns = v.campaigns.map((c) => ({ scope: c.scope, rate: c.commissionRate, targetIds: c.targetIds ?? [], endsAt: c.endsAt }));
        writeCache(token, code, campaigns);
        setInfo({ t: token.slice(-16), code, campaigns });
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof AffiliateApiError && (e.code === "not_partner" || e.code === "unauthorized")) writeCache(token, null, []);
        setInfo(null);
      });
    return () => { alive = false; };
  }, [token]);

  if (!info?.code || !productNumericId) return null;
  const link = `${window.location.origin}/a/${info.code}?p=/product/${productNumericId}`;
  const pct = Math.round(rateFor(info.campaigns, productNumericId) * 100);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("紹介リンクをコピーしました。ストーリーズに貼ってシェアしよう", { position: "top-center" });
    } catch {
      toast.error("コピーできませんでした。長押しでコピーしてください。");
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-3 flex items-center gap-3">
      <Sparkles className="h-5 w-5 text-primary shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">この商品をシェアして、売上の{pct}%をもらおう</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">リンクをコピーしてストーリーズに貼るだけ</p>
      </div>
      <button onClick={copy} className="shrink-0 inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-2 text-xs font-semibold whitespace-nowrap" aria-label="紹介リンクをコピー">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        リンクをコピー
      </button>
    </div>
  );
}
