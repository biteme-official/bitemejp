/**
 * LINE 로그인 보상 쿠폰(WELCOME10 · 연결 유도 LINKUP10) 예상 할인액 한 줄.
 *
 * 쿠폰은 Shopify 결제 페이지에서 붙는다(cartStore.createCheckout). 장바구니에선 금액이 안 보여
 * 「할인이 안 되는 것 같다」는 오해가 생겨, 결제에서 실제로 넣을 코드와 같은 판정으로 미리 보여준다.
 *
 * ⚠️ 쿠폰 키는 로그인 때마다 저장되고 지워지지 않는다. 키만 보고 띄우면 기존 연결 고객·이미 쓴 사람에게도
 *    보여서(#236 → #241 되돌림) **이번에 새로 연결 + 서버가 「미사용」 확인**일 때만 보인다 (#242).
 *    미사용 판정은 로그인한 Shopify 고객 기준 = Shopify 1인 1회 판정과 같은 기준. 조회 중·실패는 숨김.
 *    최종 판정은 여전히 Shopify 결제 단계라 「約」 + 결제 화면 확인 문구를 두고, 합계에는 더하지 않는다.
 */
import { useAuthStore } from "@/stores/authStore";
import { formatPrice } from "@/lib/shopify";
import { getAffiliateOffer, orderOfferAndWelcome } from "@/lib/affiliate-offer";
import { LINE_NEW_LINK_KEY, LINE_WELCOME_DISCOUNT_KEY, LINE_WELCOME_DISCOUNT_PERCENT } from "@/lib/lineWelcomeDiscount";
import { useWelcomeCouponStatus } from "@/lib/welcomeCouponStatus";

interface Props {
  /** 쿠폰이 걸릴 금액 — 자동 할인이 있으면 할인 후 금액(주문 할인은 상품 할인 뒤에 계산된다) */
  base: number;
  lines: Array<{ productId: string; unitPrice: number; quantity: number }>;
  currencyCode: string;
}

export function WelcomeCouponNote({ base, lines, currencyCode }: Props) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const lineSessionToken = useAuthStore((s) => s.user?.lineSessionToken);

  let welcome: string | null = null;
  let affiliateCode: string | null = null;
  let newlyLinked = false;
  try {
    welcome = localStorage.getItem(LINE_WELCOME_DISCOUNT_KEY);
    affiliateCode = localStorage.getItem("affiliate_discount");
    newlyLinked = localStorage.getItem(LINE_NEW_LINK_KEY) === "1";
  } catch { /* 무시 — 줄을 안 보여줄 뿐 */ }
  // cartStore 와 같은 판정: 특별 코드(/discount/)가 있으면 웰컴은 안 넣는다
  // 이번에 새로 연결한 사람에게만 — 기존 연결 고객에겐 안 보인다
  const candidate = isLoggedIn && newlyLinked && base > 0 && welcome && !affiliateCode ? welcome : null;
  const usage = useWelcomeCouponStatus(candidate, lineSessionToken);
  if (!candidate || usage !== "unused") return null;
  // 파트너 링크 할인이 더 크면 그쪽이 간다 — 그 줄은 AffiliateOfferNote 가 보여준다
  const decided = orderOfferAndWelcome(getAffiliateOffer(), isLoggedIn, { code: candidate, percent: LINE_WELCOME_DISCOUNT_PERCENT }, lines);
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
