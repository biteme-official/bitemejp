import { useState, useEffect } from "react";
import { Gift, Truck } from "lucide-react";
import { useCartStore } from "@/stores/cartStore";
import { useTranslation } from "@/hooks/useTranslation";
import { fetchShippingRates, fetchCartPreview, ShippingRate } from "@/lib/shopify";
import { GIFT_ENABLED, GIFT_THRESHOLD } from "@/config/giftConfig";
import { FREE_SHIP_THRESHOLD, isFreeShipActive } from "@/config/freeShipConfig";
import { estimateCheckoutCouponDiscount, CheckoutCouponEstimate } from "@/lib/checkoutCouponEstimate";

export function ThresholdBanner() {
  const items = useCartStore(state => state.items);
  const [shippingRate, setShippingRate] = useState<ShippingRate | null>(null);
  const [discountedTotal, setDiscountedTotal] = useState<number | null>(null);
  const [previewedItems, setPreviewedItems] = useState<typeof items | null>(null);
  const [couponEstimate, setCouponEstimate] = useState<CheckoutCouponEstimate | null>(null);
  const { formatPrice } = useTranslation();

  const nonGiftItems = items.filter(i => !i.isGift);

  useEffect(() => {
    if (nonGiftItems.length === 0) { setShippingRate(null); return; }
    const lineItems = nonGiftItems.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    fetchShippingRates("JP", lineItems)
      .then((rates) => {
        const nonFreeRate = rates.find((r) => parseFloat(r.amount) > 0);
        if (nonFreeRate) setShippingRate(nonFreeRate);
      })
      .catch(console.error);
  }, [items]);

  // 할인가 기준으로 프로그레스 계산
  useEffect(() => {
    if (nonGiftItems.length === 0) { setDiscountedTotal(0); return; }
    let alive = true;
    fetchCartPreview(nonGiftItems.map(i => ({ variantId: i.variantId, quantity: i.quantity })))
      .then(info => {
        if (!alive) return;
        setDiscountedTotal(info?.discountedTotal ?? null);
        setPreviewedItems(info ? items : null);
      })
      .catch(() => { if (alive) { setDiscountedTotal(null); setPreviewedItems(null); } });
    return () => { alive = false; };
  }, [items]);

  // 무료배송 기준은 쿠폰까지 뺀 금액이다 — 지금 장바구니의 자동 할인 뒤 금액이 나온 다음에 쿠폰을 뺀다
  useEffect(() => {
    setCouponEstimate(null);
    if (!isFreeShipActive() || nonGiftItems.length === 0 || previewedItems !== items || discountedTotal === null) return;
    const lines = nonGiftItems.map(i => ({ productId: i.product.node.id, unitPrice: parseFloat(i.price.amount), quantity: i.quantity }));
    let alive = true;
    estimateCheckoutCouponDiscount(discountedTotal, lines)
      .then(estimate => { if (alive) setCouponEstimate(estimate); })
      .catch(console.error);
    return () => { alive = false; };
  }, [items, discountedTotal, previewedItems]);

  if (items.length === 0) return null;

  const currencyCode = items[0]?.price.currencyCode || "JPY";

  // 할인가 로드 전에는 정가 기준으로 fallback
  const effectiveTotal = discountedTotal
    ?? nonGiftItems.reduce((sum, i) => sum + parseFloat(i.price.amount) * i.quantity, 0);

  const giftUnlocked = effectiveTotal >= GIFT_THRESHOLD;
  const remaining = Math.max(0, GIFT_THRESHOLD - effectiveTotal);
  const progress = Math.min(100, (effectiveTotal / GIFT_THRESHOLD) * 100);

  // 블프 무료배송(¥6,000 이상) 안내 — 쿠폰까지 뺀 금액 기준. 실제 적용은 Shopify 자동 할인이 결제 때 한다
  const freeShipActive = isFreeShipActive();
  // 금액이 확정되기 전(조회 중·실패)에는 무료배송을 단정하지 않는다 — 정가로 판단하면 15% 자동 할인이 빠진다
  const freeShipSettled = previewedItems === items && discountedTotal !== null && couponEstimate !== null;
  const freeShipTotal = effectiveTotal - (couponEstimate?.amount ?? 0);
  const freeShipReached = freeShipSettled && freeShipTotal >= FREE_SHIP_THRESHOLD;
  const freeShipUnlocked = freeShipActive && freeShipReached && !couponEstimate?.hasUnknownCode;
  const freeShipRemaining = Math.max(0, FREE_SHIP_THRESHOLD - freeShipTotal);
  const freeShipProgress = freeShipSettled ? Math.min(100, (freeShipTotal / FREE_SHIP_THRESHOLD) * 100) : 0;
  const freeShipThresholdLabel = formatPrice(FREE_SHIP_THRESHOLD, currencyCode);
  const freeShipMessage = !freeShipSettled
    ? `${freeShipThresholdLabel}以上で送料無料`
    : freeShipUnlocked
      ? '送料無料になりました（お支払い時に適用）'
      : freeShipReached
        ? `クーポン適用後の金額が${freeShipThresholdLabel}以上なら送料無料`
        : `あと ${formatPrice(freeShipRemaining, currencyCode)} で送料無料`;

  return (
    <div className="space-y-2 mb-4">
      {freeShipActive && (
        <div className={`border rounded-lg p-3 transition-colors ${freeShipUnlocked ? 'bg-primary/5 border-primary/30' : 'bg-card border-border'}`}>
          <div className="flex items-center gap-2 mb-2">
            <Truck className={`h-4 w-4 flex-shrink-0 ${freeShipUnlocked ? 'text-primary' : 'text-muted-foreground'}`} />
            <span className="text-sm font-medium">{freeShipMessage}</span>
          </div>
          <div className="w-full bg-muted rounded-full h-1.5">
            <div className="bg-primary h-1.5 rounded-full transition-all duration-500" style={{ width: `${freeShipProgress}%` }} />
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">※クーポン適用後の金額で判定します</p>
        </div>
      )}

      {/* Gift threshold banner — 증정을 끈 동안엔 숨김 */}
      {GIFT_ENABLED && <div className={`border rounded-lg p-3 transition-colors ${giftUnlocked ? 'bg-primary/5 border-primary/30' : 'bg-card border-border'}`}>
        <div className="flex items-center gap-2 mb-2">
          <Gift className={`h-4 w-4 flex-shrink-0 ${giftUnlocked ? 'text-primary' : 'text-muted-foreground'}`} />
          <span className="text-sm font-medium">
            {giftUnlocked
              ? '🎁 BITE ME サマーうちわ がプレゼントされました！'
              : `あと ${formatPrice(remaining, currencyCode)} で BITE ME サマーうちわ プレゼント`}
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-1.5">
          <div
            className="bg-primary h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>}

      {/* Shipping rate */}
      {/* 무료배송 조건을 채우면 「送料 ¥…」 줄은 숨긴다 */}
      {shippingRate && !freeShipUnlocked && (
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-primary flex-shrink-0" />
            <span className="text-sm text-muted-foreground">
              送料: {formatPrice(parseFloat(shippingRate.amount), currencyCode)}
              <span className="text-xs ml-1">({shippingRate.title})</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
