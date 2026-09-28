/**
 * 파트너 링크로 들어온 고객에게 「紹介リンク限定 n%OFF」 안내 (#178, 2026-09-28)
 *
 *  - 상품 상세(variant="product"): 이 상품이 할인 대상일 때만. 회원이면 할인가, 비회원이면 LINE 로그인 버튼
 *  - 장바구니(variant="cart"): 대상 상품이 담겨 있으면 예상 할인액 한 줄
 *
 * 실제 할인은 Shopify 결제 페이지에서 붙는다(cartStore.createCheckout). 여기 금액은 정가 기준 추정이다.
 */
import { useState } from "react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/authStore";
import { initiateLineLogin } from "@/lib/line-auth";
import { formatPrice } from "@/lib/shopify";
import { getAffiliateOffer, offerAppliesTo, offerDiscountAmount, orderOfferAndWelcome } from "@/lib/affiliate-offer";
import { LINE_WELCOME_DISCOUNT_KEY, LINE_WELCOME_DISCOUNT_PERCENT } from "@/lib/lineWelcomeDiscount";

type Props =
  | { variant: "product"; productId: string; unitPrice: number; currencyCode: string }
  | { variant: "cart"; lines: Array<{ productId: string; unitPrice: number; quantity: number }>; currencyCode: string };

export function AffiliateOfferNote(props: Props) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  // 렌더마다 localStorage 를 읽지 않도록 첫 렌더에 한 번
  const [offer] = useState(() => getAffiliateOffer());
  if (!offer) return null;

  const login = () => {
    initiateLineLogin({ returnTo: window.location.pathname + window.location.search, src: "button" })
      .catch(() => toast.error("LINEログインを開始できませんでした"));
  };

  if (props.variant === "product") {
    if (!offerAppliesTo(offer, props.productId)) return null;
    const discounted = props.unitPrice - Math.floor((props.unitPrice * offer.percent) / 100);
    return (
      <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {isLoggedIn ? (
          <p>
            <span className="font-semibold">紹介リンク限定 {offer.percent}%OFF</span>
            {" "}— お支払い時に自動で適用されます（
            <span translate="no">{formatPrice(discounted.toFixed(0), props.currencyCode)}</span>）
          </p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p><span className="font-semibold">LINEログインで紹介リンク限定 {offer.percent}%OFF</span></p>
            <button onClick={login} className="shrink-0 rounded-md bg-[#06C755] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90">
              LINEでログイン
            </button>
          </div>
        )}
      </div>
    );
  }

  const amount = offerDiscountAmount(offer, props.lines);
  if (amount <= 0) return null;
  // 웰컴 쿠폰 쪽이 더 크면 결제에서 웰컴이 먼저 간다 — 링크 할인 줄은 숨긴다 (cartStore 와 같은 판정)
  let welcome: string | null = null;
  try { welcome = localStorage.getItem(LINE_WELCOME_DISCOUNT_KEY); } catch { /* 무시 */ }
  const decided = orderOfferAndWelcome(offer, isLoggedIn, welcome ? { code: welcome, percent: LINE_WELCOME_DISCOUNT_PERCENT } : null, props.lines);
  if (isLoggedIn && decided?.chosen === "welcome") return null;
  return (
    <div className="flex justify-between items-center text-xs bg-red-50 px-3 py-2 rounded-lg text-red-700">
      {isLoggedIn ? (
        <>
          <span>紹介リンク限定 {offer.percent}%OFF（お支払い時に適用）</span>
          <span className="font-semibold" translate="no">約 -{formatPrice(amount.toFixed(0), props.currencyCode)}</span>
        </>
      ) : (
        <>
          <span>LINEログインで紹介リンク限定 {offer.percent}%OFF</span>
          <button onClick={login} className="shrink-0 rounded-md bg-[#06C755] px-2.5 py-1 text-[11px] font-medium text-white">ログイン</button>
        </>
      )}
    </div>
  );
}
