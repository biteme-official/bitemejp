/**
 * LINE 로그인 보상 쿠폰(WELCOME10 · 연결 유도 LINKUP10) 예상 할인액 한 줄.
 *
 * 쿠폰은 Shopify 결제 페이지에서 붙는다(cartStore.createCheckout). 장바구니에선 금액이 안 보여
 * 「할인이 안 되는 것 같다」는 오해가 생겨, 결제에서 실제로 넣을 코드와 같은 판정으로 미리 보여준다.
 *
 * ⚠️ 1인 1회 소진 여부는 우리가 모른다(Shopify 가 결제 때 판정). 그래서 「約」 + 1회 한정 문구를 붙이고
 *    합계에는 더하지 않는다 — 이미 쓴 사람에게 합계까지 깎아 보여주면 결제창에서 금액이 뛴다.
 */
import { useAuthStore } from "@/stores/authStore";
import { formatPrice } from "@/lib/shopify";
import { getAffiliateOffer, orderOfferAndWelcome } from "@/lib/affiliate-offer";
import { LINE_WELCOME_DISCOUNT_KEY, LINE_WELCOME_DISCOUNT_PERCENT } from "@/lib/lineWelcomeDiscount";

interface Props {
  /** 쿠폰이 걸릴 금액 — 자동 할인이 있으면 할인 후 금액(주문 할인은 상품 할인 뒤에 계산된다) */
  base: number;
  lines: Array<{ productId: string; unitPrice: number; quantity: number }>;
  currencyCode: string;
}

export function WelcomeCouponNote({ base, lines, currencyCode }: Props) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  if (!isLoggedIn || base <= 0) return null;

  let welcome: string | null = null;
  let affiliateCode: string | null = null;
  try {
    welcome = localStorage.getItem(LINE_WELCOME_DISCOUNT_KEY);
    affiliateCode = localStorage.getItem("affiliate_discount");
  } catch { /* 무시 — 줄을 안 보여줄 뿐 */ }
  // cartStore 와 같은 판정: 특별 코드(/discount/)가 있으면 웰컴은 안 넣는다
  if (!welcome || affiliateCode) return null;
  // 파트너 링크 할인이 더 크면 그쪽이 간다 — 그 줄은 AffiliateOfferNote 가 보여준다
  const decided = orderOfferAndWelcome(getAffiliateOffer(), isLoggedIn, { code: welcome, percent: LINE_WELCOME_DISCOUNT_PERCENT }, lines);
  if (decided?.chosen === "offer") return null;

  const amount = Math.floor((base * LINE_WELCOME_DISCOUNT_PERCENT) / 100);
  if (amount <= 0) return null;
  return (
    <div className="text-xs bg-red-50 px-3 py-2 rounded-lg text-red-700">
      <div className="flex justify-between items-start gap-2">
        <span>LINE会員クーポン {LINE_WELCOME_DISCOUNT_PERCENT}%OFF（お支払い時に自動適用）</span>
        <span className="font-semibold shrink-0 whitespace-nowrap" translate="no">約 -{formatPrice(amount.toFixed(0), currencyCode)}</span>
      </div>
      <p className="mt-0.5 text-[10px] text-red-500">※お一人さま1回限り。ご利用済みの場合は適用されません。最終的な割引額はお支払い画面でご確認ください</p>
    </div>
  );
}
