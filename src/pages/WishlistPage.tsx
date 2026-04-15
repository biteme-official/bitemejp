import { useNavigate } from "react-router-dom";
import { Heart, ShoppingCart, Trash2 } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Button } from "@/components/ui/button";
import { useWishlistStore } from "@/stores/wishlistStore";
import { useCartStore } from "@/stores/cartStore";
import { formatPrice } from "@/lib/shopify";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "sonner";

export default function WishlistPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { items, removeItem } = useWishlistStore();
  const addItem = useCartStore(state => state.addItem);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-8">
        <div className="flex items-center gap-2 mb-6">
          <Heart className="h-5 w-5 text-red-500 fill-red-500" />
          <h1 className="text-xl font-bold">お気に入り</h1>
          <span className="text-sm text-muted-foreground">({items.length}件)</span>
        </div>

        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Heart className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground font-medium mb-1">お気に入りはまだありません</p>
            <p className="text-sm text-muted-foreground mb-6">気になる商品をハートマークで追加しましょう</p>
            <Button variant="outline" onClick={() => navigate("/")}>
              ショッピングを続ける
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((item) => (
              <div
                key={item.productId}
                className="bg-card border border-border rounded-lg overflow-hidden flex flex-col"
              >
                {/* Image */}
                <button
                  onClick={() => navigate(`/product/${item.handle}`)}
                  className="aspect-square bg-secondary overflow-hidden"
                >
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      className="w-full h-full object-cover hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-4xl">🐕</div>
                  )}
                </button>

                {/* Info */}
                <div className="p-3 flex flex-col flex-1 gap-2">
                  <button
                    onClick={() => navigate(`/product/${item.handle}`)}
                    className="text-left"
                  >
                    <p className="text-sm font-medium line-clamp-2 leading-snug">{item.title}</p>
                    <p className="text-sm font-bold text-primary mt-1">
                      {formatPrice(item.price, item.currencyCode)}
                    </p>
                  </button>

                  {/* Actions */}
                  <div className="flex gap-1 mt-auto">
                    <Button
                      size="sm"
                      className="flex-1 h-8 text-xs"
                      onClick={() => navigate(`/product/${item.handle}`)}
                    >
                      <ShoppingCart className="h-3 w-3 mr-1" />
                      購入する
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        removeItem(item.productId);
                        toast.success("お気に入りから削除しました", { position: "top-center" });
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
