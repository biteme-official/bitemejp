/**
 * 상품 상세의 「この商品の紹介リンクをコピー」 — 로그인한 파트너에게만 보인다 (#178, 하영 요청 2026-09-21).
 *
 * 파트너 페이지의 기본 링크는 홈으로 가지만, 인스타에 올리는 건 결국 특정 상품이다. 쿠팡 파트너스처럼
 * 상품 페이지에서 바로 `biteme.co.jp/a/CODE?p=/product/ID` 를 받게 한다.
 *
 * 파트너 여부는 세션 동안 한 번만 묻는다(sessionStorage) — 상품을 볼 때마다 API 를 부르지 않기 위해.
 * 파트너가 아니거나 비로그인이면 아무것도 그리지 않는다.
 */
import { useEffect, useState } from "react";
import { Copy, Check, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/authStore";
import { AffiliateApiError, fetchPartnerView } from "@/lib/affiliate-api";

const CACHE_KEY = "aff_partner_code";
const NONE = "-";

function readCache(token: string): string | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { t: string; code: string };
    // 토큰이 바뀌었으면(재로그인) 캐시를 버린다
    return v.t === token.slice(-16) ? v.code : null;
  } catch { return null; }
}
function writeCache(token: string, code: string) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: token.slice(-16), code })); } catch { /* 무시 */ }
}

export function PartnerProductLink({ productNumericId }: { productNumericId: string | null }) {
  const token = useAuthStore((s) => s.user?.lineSessionToken);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) { setCode(null); return; }
    const cached = readCache(token);
    if (cached) { setCode(cached === NONE ? null : cached); return; }
    let alive = true;
    fetchPartnerView(token)
      .then((v) => { if (!alive) return; const c = v.partner.status === "active" ? v.partner.code : NONE; writeCache(token, c); setCode(c === NONE ? null : c); })
      .catch((e) => { if (!alive) return; if (e instanceof AffiliateApiError && (e.code === "not_partner" || e.code === "unauthorized")) writeCache(token, NONE); setCode(null); });
    return () => { alive = false; };
  }, [token]);

  if (!code || !productNumericId) return null;
  const link = `${window.location.origin}/a/${code}?p=/product/${productNumericId}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("紹介リンクをコピーしました", { position: "top-center" });
    } catch {
      toast.error("コピーできませんでした。長押しでコピーしてください。");
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5 flex items-center gap-2">
      <Link2 className="h-4 w-4 text-primary shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">パートナー：この商品の紹介リンク</p>
        <p className="text-[11px] text-muted-foreground truncate" translate="no">{link}</p>
      </div>
      <button onClick={copy} className="shrink-0 inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-2.5 py-1.5 text-xs font-medium" aria-label="紹介リンクをコピー">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        コピー
      </button>
    </div>
  );
}
