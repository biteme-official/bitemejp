import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { CheckCircle, Home } from "lucide-react";
import { useCartStore } from "@/stores/cartStore";
import { useTranslation } from "@/hooks/useTranslation";
import { Confetti } from "@/components/checkout/Confetti";

export default function CheckoutReturn() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const clearCart = useCartStore(state => state.clearCart);

  useEffect(() => {
    clearCart();
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
