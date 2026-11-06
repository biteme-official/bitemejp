/**
 * 결제 때 붙을 쿠폰 할인액 추정 — 장바구니 무료배송 안내용.
 *
 * Shopify 무료배송 최소 금액은 쿠폰까지 뺀 금액으로 본다. 장바구니 금액에는 쿠폰이 안 들어가므로,
 * 그대로 보여주면 「送料無料」 라고 안내한 주문에 결제 때 배송비가 붙는다.
 * 코드 선택은 cartStore.createCheckout 과 같은 규칙이다. 그쪽을 바꾸면 여기도 같이 바꾼다.
 *
 * 특별 코드(/discount/)는 할인율을 알 수 없어 0 으로 둔다. 안내 문구의 ※ 가 이 경우를 덮는다.
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

/**
 * @param base 쿠폰이 걸릴 금액 — 자동 할인 뒤 금액
 * @param lines 장바구니 상품(정가 기준)
 */
export async function estimateCheckoutCouponDiscount(base: number, lines: Line[]): Promise<number> {
  if (localStorage.getItem("affiliate_discount")) return 0;

  const { user, isLoggedIn } = useAuthStore.getState();
  const token = user?.lineSessionToken;
  const welcomeCode = localStorage.getItem(LINE_WELCOME_DISCOUNT_KEY);
  const welcomeUsage = welcomeCode && token ? await getWelcomeCouponUsage(welcomeCode, token) : "unknown";
  const bfCode = await resolveBfCode(token);

  // 웰컴을 안 썼으면 웰컴, 아니면 블프 5%. 둘 다 없으면 쿠폰 없음
  const coupon =
    welcomeCode && welcomeUsage === "unused"
      ? { code: welcomeCode, percent: LINE_WELCOME_DISCOUNT_PERCENT }
      : bfCode
        ? { code: bfCode, percent: BF_PERCENT }
        : null;

  const offer = getAffiliateOffer();
  const decided = orderOfferAndWelcome(offer, isLoggedIn, coupon, lines);
  if (offer && decided?.chosen === "offer") return offerDiscountAmount(offer, lines);
  return coupon ? Math.floor((base * coupon.percent) / 100) : 0;
}
