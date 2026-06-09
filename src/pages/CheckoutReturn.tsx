import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { CheckCircle, Home } from "lucide-react";
import { useCartStore } from "@/stores/cartStore";
import { useTranslation } from "@/hooks/useTranslation";
import { Confetti } from "@/components/checkout/Confetti";
import { trackPurchase } from "@/lib/ga4-ecommerce";
import { track } from "@/lib/track";

export default function CheckoutReturn() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const clearCart = useCartStore(state => state.clearCart);

  useEffect(() => {
    clearCart();

    // Shopify checkout → biteme.co.jp 복귀 시 purchase 이벤트 발생
    // cross-domain attribution 문제를 우회하여 biteme.co.jp 세션에서 직접 집계
    const raw = sessionStorage.getItem('checkout_ga4');
    if (raw) {
      try {
        const { transactionId, items, currency, value, shipping } = JSON.parse(raw);
        trackPurchase(transactionId, items, currency, value, shipping);
        track('order_complete', {
          order_id: transactionId,
          order_value: value,
          item_count: Array.isArray(items) ? items.length : 0,
          currency,
        });

        // Meta Pixel Purchase
        const fbq = (window as Window & { fbq?: (...args: unknown[]) => void }).fbq;
        if (fbq) {
          fbq('track', 'Purchase', {
            value,
            currency,
            content_ids: items.map((item: { item_id: string }) => item.item_id),
            content_type: 'product',
            contents: items.map((item: { item_id: string; quantity: number; price: number }) => ({
              id: item.item_id,
              quantity: item.quantity,
              item_price: item.price,
            })),
            num_items: items.reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0),
          });
        }
      } catch { /* ignore */ }
      sessionStorage.removeItem('checkout_ga4');
    }
  }, [clearCart]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Confetti />
      <header className="sticky top-0 z-50 bg-card border-b border-border">
        <div className="flex items-center justify-center px-4 h-14">
          <h1 className="font-semibold text-foreground">{t('checkout.returnTitle')}</h1>
        </div>
      </header>
      <main className="flex-1 flex flex-col items-center px-6 py-8 pb-24">
        <div className="w-full max-w-md space-y-6">
          <motion.div
            className="flex justify-center"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 15, delay: 0.2 }}
          >
            <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center">
              <CheckCircle className="w-10 h-10 text-primary" />
            </div>
          </motion.div>
          <motion.div
            className="text-center space-y-2"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
          >
            <h2 className="text-2xl font-bold text-foreground">{t('checkout.thankYou')}</h2>
            <p className="text-muted-foreground">{t('checkout.orderConfirmation')}</p>
          </motion.div>
          <div className="space-y-3 pt-2">
            <Button onClick={() => navigate('/')} className="w-full" size="lg">
              <Home className="w-4 h-4 mr-2" />
              {t('checkout.continueShopping')}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
