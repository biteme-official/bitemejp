import { useState, useEffect } from "react";
import { Gift, Truck } from "lucide-react";
import { useCartStore } from "@/stores/cartStore";
import { useTranslation } from "@/hooks/useTranslation";
import { fetchShippingRates, fetchCartPreview, ShippingRate } from "@/lib/shopify";
import { GIFT_THRESHOLD } from "@/config/giftConfig";

export function ThresholdBanner() {
  const items = useCartStore(state => state.items);
  const [shippingRate, setShippingRate] = useState<ShippingRate | null>(null);
  const [discountedTotal, setDiscountedTotal] = useState<number | null>(null);
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
    fetchCartPreview(nonGiftItems.map(i => ({ variantId: i.variantId, quantity: i.quantity })))
      .then(info => setDiscountedTotal(info?.discountedTotal ?? null))
      .catch(() => setDiscountedTotal(null));
  }, [items]);

  if (items.length === 0) return null;

  const currencyCode = items[0]?.price.currencyCode || "JPY";

  // 할인가 로드 전에는 정가 기준으로 fallback
  const effectiveTotal = discountedTotal
    ?? nonGiftItems.reduce((sum, i) => sum + parseFloat(i.price.amount) * i.quantity, 0);

  const giftUnlocked = effectiveTotal >= GIFT_THRESHOLD;
  const remaining = Math.max(0, GIFT_THRESHOLD - effectiveTotal);
  const progress = Math.min(100, (effectiveTotal / GIFT_THRESHOLD) * 100);

  return (
    <div className="space-y-2 mb-4">
      {/* Gift threshold banner */}
      <div className={`border rounded-lg p-3 transition-colors ${giftUnlocked ? 'bg-primary/5 border-primary/30' : 'bg-card border-border'}`}>
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
      </div>

      {/* Shipping rate */}
      {shippingRate && (
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
