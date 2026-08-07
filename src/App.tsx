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
import AdminDashboard from "./pages/AdminDashboard";
import TokushoHo from "./pages/TokushoHo";
import About from "./pages/About";
import DiscountRedirect from "./pages/DiscountRedirect";
import BlogList from "./pages/BlogList";
import BlogPost from "./pages/BlogPost";
import Affiliate from "./pages/Affiliate";
import { LineFloatingButton } from "./components/layout/LineFloatingButton";
import { NoticeBanner } from "./components/layout/NoticeBanner";
import { useCartStore } from "@/stores/cartStore";

const queryClient = new QueryClient();

function GA4PageViewTracker() {
  const location = useLocation();
  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);
  return null;
}

// 체크아웃 후 사이트 복귀 시 장바구니 자동 클리어
function CheckoutReturnGuard() {
  const clearCart = useCartStore((state) => state.clearCart);
  useEffect(() => {
    if (sessionStorage.getItem('checkout_pending')) {
      sessionStorage.removeItem('checkout_pending');
      clearCart();
    }
  }, [clearCart]);
  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <BrowserRouter>
        <GA4PageViewTracker />
        <CheckoutReturnGuard />
        <Toaster />
        <Sonner closeButton />
        <NoticeBanner />
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
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/tokusho" element={<TokushoHo />} />
          <Route path="/about" element={<About />} />
          <Route path="/discount/:code" element={<DiscountRedirect />} />
          <Route path="/blog" element={<BlogList />} />
          <Route path="/blog/:slug" element={<BlogPost />} />
          <Route path="/affiliate" element={<Affiliate />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <LineFloatingButton />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
