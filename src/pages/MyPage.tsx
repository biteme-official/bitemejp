import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  LogOut, User, ShoppingBag, Heart, HelpCircle, ChevronRight,
  Package, Truck, ExternalLink, MapPin, Calendar, CreditCard,
} from 'lucide-react';
import { LineLoginButton } from '@/components/auth/LineLoginButton';
import { fetchCustomerData, fetchProductByHandle, ShopifyCustomerProfile, ShopifyOrder, formatPrice } from '@/lib/shopify';
import { useFavoritesStore } from '@/stores/favoritesStore';

// --- Sub-components ---

function MenuLink({ icon: Icon, label, badge, onClick }: {
  icon: typeof ShoppingBag; label: string; badge?: string | number; onClick?: () => void;
}) {
  return (
    <button onClick={onClick} className="w-full flex items-center justify-between py-3.5 hover:bg-secondary/50 transition-colors">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 text-muted-foreground" />
        <span className="text-sm">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {badge !== undefined && (
          <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{badge}</span>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </button>
  );
}

function StatusBadge({ status, type }: { status: string; type: 'financial' | 'fulfillment' }) {
  const map: Record<string, { label: string; cls: string }> = type === 'financial' ? {
    PAID: { label: '支払済', cls: 'bg-green-100 text-green-700' },
    PENDING: { label: '処理中', cls: 'bg-yellow-100 text-yellow-700' },
    REFUNDED: { label: '返金済', cls: 'bg-gray-100 text-gray-600' },
    PARTIALLY_REFUNDED: { label: '一部返金', cls: 'bg-gray-100 text-gray-600' },
    AUTHORIZED: { label: '承認済', cls: 'bg-blue-100 text-blue-700' },
    VOIDED: { label: '無効', cls: 'bg-red-100 text-red-600' },
  } : {
    FULFILLED: { label: '発送済', cls: 'bg-green-100 text-green-700' },
    UNFULFILLED: { label: '未発送', cls: 'bg-orange-100 text-orange-700' },
    PARTIALLY_FULFILLED: { label: '一部発送', cls: 'bg-yellow-100 text-yellow-700' },
  };
  const info = map[status] || { label: status || '未発送', cls: 'bg-orange-100 text-orange-700' };
  return <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${info.cls}`}>{info.label}</span>;
}

function OrderCard({ order }: { order: ShopifyOrder }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(order.processedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full p-4 text-left">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{order.name}</span>
            <StatusBadge status={order.financialStatus} type="financial" />
            <StatusBadge status={order.fulfillmentStatus} type="fulfillment" />
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0">{date}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{order.lineItems.length} 点</span>
          <span className="text-sm font-bold" translate="no">{formatPrice(order.totalPrice.amount, order.totalPrice.currencyCode)}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
          {/* Line items */}
          {order.lineItems.map((item, i) => (
            <div key={i} className="flex items-center gap-3">
              {item.variant?.image?.url ? (
                <img src={item.variant.image.url} alt={item.title} className="w-12 h-12 rounded-lg object-cover" />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-secondary flex items-center justify-center">
                  <Package className="h-5 w-5 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{item.title}</p>
                <p className="text-xs text-muted-foreground">x{item.quantity}</p>
              </div>
            </div>
          ))}

          {/* Tracking info */}
          {order.fulfillments.length > 0 && order.fulfillments[0].trackingUrl && (
            <a
              href={order.fulfillments[0].trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-primary hover:underline"
            >
              <Truck className="h-4 w-4" />
              配送状況を確認
              {order.fulfillments[0].trackingCompany && (
                <span className="text-xs text-muted-foreground">({order.fulfillments[0].trackingCompany})</span>
              )}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}

          {/* Order status page */}
          {order.statusUrl && (
            <a
              href={order.statusUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <CreditCard className="h-4 w-4" />
              注文詳細ページ
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// --- Main Component ---

export default function MyPage() {
  const navigate = useNavigate();
  const { user, isLoggedIn, logout } = useAuthStore();
  const [customerData, setCustomerData] = useState<ShopifyCustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'orders' | 'favorites' | null>(null);
  const [favoriteProducts, setFavoriteProducts] = useState<Array<{ handle: string; title: string; image?: string; price: string; currencyCode: string }>>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const { getFavorites, removeFavorite } = useFavoritesStore();

  // Fetch customer data from Shopify
  useEffect(() => {
    if (isLoggedIn && user?.shopifyCustomerToken) {
      setLoading(true);
      fetchCustomerData(user.shopifyCustomerToken)
        .then(setCustomerData)
        .catch(console.error)
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [isLoggedIn, user?.shopifyCustomerToken]);

  // Load favorite products
  useEffect(() => {
    if (!user?.userId || activeTab !== 'favorites') return;
    const handles = getFavorites(user.userId);
    if (handles.length === 0) { setFavoriteProducts([]); return; }

    setFavoritesLoading(true);
    Promise.all(handles.map((h) => fetchProductByHandle(h).catch(() => null)))
      .then((products) => {
        setFavoriteProducts(
          products.filter(Boolean).map((p: any) => ({
            handle: p.handle, title: p.title,
            image: p.images.edges[0]?.node.url,
            price: p.priceRange.minVariantPrice.amount,
            currencyCode: p.priceRange.minVariantPrice.currencyCode,
          }))
        );
      })
      .finally(() => setFavoritesLoading(false));
  }, [user?.userId, activeTab, getFavorites]);

  const handleLogout = () => { logout(); navigate('/'); };

  // --- Not logged in ---
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-md mx-auto px-4 py-16 flex flex-col items-center text-center">
          <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-6">
            <User className="h-10 w-10 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-bold mb-2">ログインしてください</h1>
          <p className="text-sm text-muted-foreground mb-8">
            マイページを利用するには<br />LINEアカウントでのログインが必要です。
          </p>
          <div className="w-full"><LineLoginButton /></div>
          <button onClick={() => navigate('/')} className="mt-4 text-sm text-muted-foreground underline underline-offset-4">
            ショッピングを続ける
          </button>
        </main>
      </div>
    );
  }

  const orders = customerData?.orders || [];
  const favCount = user?.userId ? getFavorites(user.userId).length : 0;
  const memberSince = customerData?.createdAt
    ? new Date(customerData.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' })
    : null;

  // --- Logged in ---
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-md mx-auto px-4 py-6 space-y-4 pb-24">

        {/* Profile Card */}
        <div className="bg-card rounded-xl border border-border p-5">
          <div className="flex items-center gap-4">
            {user.pictureUrl ? (
              <img src={user.pictureUrl} alt={user.displayName} className="w-16 h-16 rounded-full object-cover ring-2 ring-border" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center ring-2 ring-border">
                <User className="h-8 w-8 text-muted-foreground" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold truncate">{user.displayName}</h2>
              {user.email && <p className="text-xs text-muted-foreground truncate">{user.email}</p>}
              <div className="flex items-center gap-3 mt-1.5">
                {memberSince && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" />{memberSince}〜
                  </span>
                )}
                {customerData && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <ShoppingBag className="h-3 w-3" />{customerData.numberOfOrders}回注文
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Default address */}
          {customerData?.defaultAddress && (
            <div className="mt-3 pt-3 border-t border-border flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                {[customerData.defaultAddress.zip, customerData.defaultAddress.province, customerData.defaultAddress.city, customerData.defaultAddress.address1]
                  .filter(Boolean).join(' ')}
              </p>
            </div>
          )}
        </div>

        {/* Menu */}
        <div className="bg-card rounded-xl border border-border divide-y divide-border px-4">
          <MenuLink
            icon={ShoppingBag}
            label="注文履歴・配送状況"
            badge={orders.length > 0 ? orders.length : undefined}
            onClick={() => setActiveTab(activeTab === 'orders' ? null : 'orders')}
          />
          <MenuLink
            icon={Heart}
            label="お気に入り"
            badge={favCount > 0 ? favCount : undefined}
            onClick={() => setActiveTab(activeTab === 'favorites' ? null : 'favorites')}
          />
          <MenuLink icon={HelpCircle} label="お問い合わせ" onClick={() => navigate('/contact')} />
        </div>

        {/* Orders */}
        {activeTab === 'orders' && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground px-1">注文履歴・配送状況</h3>
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-24 w-full rounded-xl" />
              </div>
            ) : orders.length === 0 ? (
              <div className="bg-card rounded-xl border border-border p-8 text-center">
                <ShoppingBag className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">注文履歴はまだありません</p>
              </div>
            ) : (
              orders.map((order) => <OrderCard key={order.id} order={order} />)
            )}
          </div>
        )}

        {/* Favorites */}
        {activeTab === 'favorites' && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground px-1">お気に入り</h3>
            {favoritesLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full rounded-xl" />
                <Skeleton className="h-20 w-full rounded-xl" />
              </div>
            ) : favoriteProducts.length === 0 ? (
              <div className="bg-card rounded-xl border border-border p-8 text-center">
                <Heart className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">お気に入りはまだありません</p>
                <p className="text-xs text-muted-foreground mt-1">商品のハートをタップして追加</p>
              </div>
            ) : (
              favoriteProducts.map((product) => (
                <div
                  key={product.handle}
                  className="bg-card rounded-xl border border-border p-3 flex items-center gap-3 cursor-pointer hover:bg-secondary/30 transition-colors"
                  onClick={() => navigate(`/product/${product.handle}`)}
                >
                  {product.image ? (
                    <img src={product.image} alt={product.title} className="w-16 h-16 rounded-lg object-cover" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-secondary flex items-center justify-center">
                      <Package className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{product.title}</p>
                    <p className="text-sm font-bold text-primary mt-1" translate="no">
                      {formatPrice(product.price, product.currencyCode)}
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (user?.userId) {
                        removeFavorite(user.userId, product.handle);
                        setFavoriteProducts((prev) => prev.filter((p) => p.handle !== product.handle));
                      }
                    }}
                    className="p-2 hover:bg-secondary rounded-full"
                  >
                    <Heart className="h-4 w-4 fill-red-500 text-red-500" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Logout */}
        <Button variant="outline" onClick={handleLogout} className="w-full h-12">
          <LogOut className="h-4 w-4 mr-2" />
          ログアウト
        </Button>
      </main>
    </div>
  );
}
