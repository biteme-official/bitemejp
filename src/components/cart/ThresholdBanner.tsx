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
    fetchShippingRates("JP")
      .then((rates) => {
        if (rates.length > 0) {
          setShippingRate(rates[0]);
        }
      })
      .catch(console.error);
  }, []);

  if (items.length === 0) return null;

  const total = items.reduce((sum, item) => sum + (parseFloat(item.price.amount) * item.quantity), 0);
  const currencyCode = items[0]?.price.currencyCode || "JPY";

  // If no shipping rate fetched yet, show nothing
  if (!shippingRate) return null;

  const shippingCost = parseFloat(shippingRate.amount);
  const isFreeShipping = shippingCost === 0;

  return (
    <div className="bg-card border border-border rounded-lg p-3 mb-4">
      <div className="flex items-center gap-2">
        <Truck className="h-4 w-4 text-primary flex-shrink-0" />
        {isFreeShipping ? (
          <span className="text-sm font-medium text-green-600">
            送料無料
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            送料: {formatPrice(shippingCost, currencyCode)}
            <span className="text-xs ml-1">({shippingRate.title})</span>
          </span>
        )}
      </div>
    </div>
  );
}
