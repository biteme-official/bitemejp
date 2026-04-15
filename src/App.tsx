import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { trackPageView } from "@/lib/ga4-pageview";
import Index from "./pages/Index";
import ProductDetail from "./pages/ProductDetail";
import CheckoutReturn from "./pages/CheckoutReturn";
import ContactUs from "./pages/ContactUs";
import NotFound from "./pages/NotFound";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import TermsOfUse from "./pages/TermsOfUse";
import LineCallback from "./pages/LineCallback";
import MyPage from "./pages/MyPage";
import WishlistPage from "./pages/WishlistPage";
import Checkout from "./pages/Checkout";
import { LineFloatingButton } from "./components/layout/LineFloatingButton";

const queryClient = new QueryClient();

function GA4PageViewTracker() {
  const location = useLocation();
  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);
  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <BrowserRouter>
        <GA4PageViewTracker />
        <Toaster />
        <Sonner closeButton />
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/product/:id" element={<ProductDetail />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/checkout-return" element={<CheckoutReturn />} />
          <Route path="/contact" element={<ContactUs />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/terms" element={<TermsOfUse />} />
          <Route path="/auth/line/callback" element={<LineCallback />} />
          <Route path="/mypage" element={<MyPage />} />
          <Route path="/wishlist" element={<WishlistPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <LineFloatingButton />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
