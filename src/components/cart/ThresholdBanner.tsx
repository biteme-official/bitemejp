import { useState, useEffect } from "react";
import { Truck } from "lucide-react";
import { useCartStore } from "@/stores/cartStore";
import { useTranslation } from "@/hooks/useTranslation";
import { fetchShippingRates, ShippingRate } from "@/lib/shopify";

export function ThresholdBanner() {
  const items = useCartStore(state => state.items);
  const [shippingRate, setShippingRate] = useState<ShippingRate | null>(null);
  const { formatPrice } = useTranslation();

  useEffect(() => {
    if (items.length === 0) return;
    const lineItems = items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    fetchShippingRates("JP", lineItems)
      .then((rates) => {
        const nonFreeRate = rates.find((r) => parseFloat(r.amount) > 0);
        if (nonFreeRate) setShippingRate(nonFreeRate);
      })
      .catch(console.error);
  }, [items]);

  if (items.length === 0) return null;

  const currencyCode = items[0]?.price.currencyCode || "JPY";

  if (!shippingRate) return null;

  const shippingCost = parseFloat(shippingRate.amount);

  return (
    <div className="bg-card border border-border rounded-lg p-3 mb-4">
      <div className="flex items-center gap-2">
        <Truck className="h-4 w-4 text-primary flex-shrink-0" />
        <span className="text-sm text-muted-foreground">
          送料: {formatPrice(shippingCost, currencyCode)}
          <span className="text-xs ml-1">({shippingRate.title})</span>
        </span>
      </div>
    </div>
  );
}
