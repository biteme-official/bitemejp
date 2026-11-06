/**
 * 결제 때 붙을 쿠폰 할인액 추정 — 장바구니 무료배송 안내용.
 *
 * Shopify 무료배송 최소 금액은 쿠폰까지 뺀 금액으로 본다. 장바구니 금액에는 쿠폰이 안 들어가므로,
 * 그대로 보여주면 「送料無料」 라고 안내한 주문에 결제 때 배송비가 붙는다.
 * 코드 선택은 cartStore.createCheckout 과 같은 규칙이다. 그쪽을 바꾸면 여기도 같이 바꾼다.
 *
 * 특별 코드(/discount/)는 할인율을 알 수 없다. amount 를 0 으로 두고 hasUnknownCode 로 알려,
 * 화면이 「送料無料になりました」 라고 확정하지 않게 한다.
 */
import { useAuthStore } from "@/stores/authStore";
import { getAffiliateOffer, offerDiscountAmount, orderOfferAndWelcome } from "@/lib/affiliate-offer";
import { BF_PERCENT, resolveBfCode } from "@/lib/bfCoupon";
import { LINE_WELCOME_DISCOUNT_KEY, LINE_WELCOME_DISCOUNT_PERCENT } from "@/lib/lineWelcomeDiscount";
import { getWelcomeCouponUsage } from "@/lib/welcomeCouponStatus";

interface Line {
  productId: string;
  unitPrice: number;
  quantity: number;
}

export interface CheckoutCouponEstimate {
  amount: number;
  /** 할인율을 모르는 코드가 결제에 붙는다 — amount 보다 더 빠질 수 있다 */
  hasUnknownCode: boolean;
}

/**
 * @param base 쿠폰이 걸릴 금액 — 자동 할인 뒤 금액
 * @param lines 장바구니 상품(정가 기준)
 */
export async function estimateCheckoutCouponDiscount(base: number, lines: Line[]): Promise<CheckoutCouponEstimate> {
  if (localStorage.getItem("affiliate_discount")) return { amount: 0, hasUnknownCode: true };

  const { user, isLoggedIn } = useAuthStore.getState();
  const token = user?.lineSessionToken;
  const welcomeCode = localStorage.getItem(LINE_WELCOME_DISCOUNT_KEY);
  const welcomeUsage = welcomeCode && token ? await getWelcomeCouponUsage(welcomeCode, token) : "unknown";
  const bfCode = await resolveBfCode(token);

  // 블프 5% 가 있으면 웰컴은 「미사용」 이 확인될 때만 고른다. 블프가 없으면 결제는 사용 여부를 묻지 않고
  // 웰컴을 보내므로, 「사용함」 이 확인된 경우(Shopify 가 무시)만 뺀다
  const useWelcome = !!welcomeCode && (bfCode ? welcomeUsage === "unused" : welcomeUsage !== "used");
  const coupon = useWelcome
    ? { code: welcomeCode, percent: LINE_WELCOME_DISCOUNT_PERCENT }
    : bfCode
      ? { code: bfCode, percent: BF_PERCENT }
      : null;

  const offer = getAffiliateOffer();
  const decided = orderOfferAndWelcome(offer, isLoggedIn, coupon, lines);
  if (offer && decided?.chosen === "offer") return { amount: offerDiscountAmount(offer, lines), hasUnknownCode: false };
  return { amount: coupon ? Math.floor((base * coupon.percent) / 100) : 0, hasUnknownCode: false };
}
