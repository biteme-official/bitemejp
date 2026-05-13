import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Loader2, Truck, CreditCard, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCartStore } from '@/stores/cartStore';
import { useAuthStore } from '@/stores/authStore';
import { formatPrice, fetchShippingRates, fetchCustomerData, ShippingRate, getPreorderDate, fetchCartPreview, CartDiscountInfo } from '@/lib/shopify';
import { getGA4LinkerParam } from '@/lib/ga4-ecommerce';
import { toast } from 'sonner';

interface ShippingForm {
  email: string;
  lastName: string;
  firstName: string;
  zip: string;
  prefecture: string;
  city: string;
  address1: string;
  address2: string;
  phone: string;
}

const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県',
  '静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県',
  '奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県',
  '熊本県','大分県','宮崎県','鹿児島県','沖縄県',
];

export default function Checkout() {
  const navigate = useNavigate();
  const { items, isLoading, createCheckout } = useCartStore();
  const user = useAuthStore((s) => s.user);
  const [shippingRate, setShippingRate] = useState<ShippingRate | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [discountInfo, setDiscountInfo] = useState<CartDiscountInfo | null>(null);

  // Load saved shipping address
  const [form, setForm] = useState<ShippingForm>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('checkout-shipping') || '{}');
      return {
        email: user?.email || saved.email || user?.shopifyEmail || '',
        lastName: saved.lastName || '',
        firstName: saved.firstName || '',
        zip: saved.zip || '',
        prefecture: saved.prefecture || '',
        city: saved.city || '',
        address1: saved.address1 || '',
        address2: saved.address2 || '',
        phone: saved.phone || '',
      };
    } catch {
      return { email: user?.email || user?.shopifyEmail || '', lastName: '', firstName: '', zip: '', prefecture: '', city: '', address1: '', address2: '', phone: '' };
    }
  });

  // Fetch shipping rate
  useEffect(() => {
    fetchShippingRates('JP')
      .then((rates) => { if (rates.length > 0) setShippingRate(rates[0]); })
      .catch(console.error);
  }, []);

  // Shopify Cart API로 자동할인 금액 조회
  useEffect(() => {
    if (items.length === 0) return;
    fetchCartPreview(items.map(i => ({ variantId: i.variantId, quantity: i.quantity })))
      .then(setDiscountInfo)
      .catch(() => setDiscountInfo(null));
  }, []);

  // Pre-fill from Shopify customer data if available
  useEffect(() => {
    if (!user?.shopifyCustomerToken) return;
    fetchCustomerData(user.shopifyCustomerToken).then((data) => {
      if (!data) return;
      const addr = data.defaultAddress;
      setForm((prev) => ({
        email: data.email || prev.email || '',
        lastName: data.lastName || prev.lastName || '',
        firstName: data.firstName || prev.firstName || '',
        zip: addr?.zip || prev.zip || '',
        prefecture: addr?.province || prev.prefecture || '',
        city: addr?.city || prev.city || '',
        address1: addr?.address1 || prev.address1 || '',
        address2: prev.address2 || '',
        phone: data.phone || prev.phone || '',
      }));
    }).catch(console.error);
  }, [user?.shopifyCustomerToken]);

  // Redirect if cart is empty
  useEffect(() => {
    if (items.length === 0) navigate('/');
  }, [items.length, navigate]);

  const updateField = (field: keyof ShippingForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  // Auto-fill address from zip code (Japan Post API)
  const handleZipLookup = async () => {
    const zip = form.zip.replace(/[^0-9]/g, '');
    if (zip.length !== 7) return;
    try {
      const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`);
      const data = await res.json();
      if (data.results?.[0]) {
        const r = data.results[0];
        setForm((prev) => ({
          ...prev,
          prefecture: r.address1,
          city: r.address2 + r.address3,
        }));
      }
    } catch { /* ignore */ }
  };

  const subtotal = items.reduce((sum, item) => sum + parseFloat(item.price.amount) * item.quantity, 0);
  const shipping = shippingRate ? parseFloat(shippingRate.amount) : 0;
  const total = subtotal + shipping;
  const currencyCode = items[0]?.price.currencyCode || 'JPY';

  const isFormValid = form.email && form.lastName && form.zip && form.prefecture && form.city && form.address1;

  const handleSubmit = async () => {
    if (!isFormValid || isSubmitting) return;
    setIsSubmitting(true);
    // Save shipping address for next time
    try { localStorage.setItem('checkout-shipping', JSON.stringify(form)); } catch { /* ignore */ }
    try {
      const lineItems = items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
      }));
      const checkoutUrl = await createCheckout(lineItems, form.email);
      if (checkoutUrl) {
        // Append shipping info as URL params for Shopify pre-fill
        const url = new URL(checkoutUrl);
        url.searchParams.set('checkout[email]', form.email);
        url.searchParams.set('checkout[shipping_address][last_name]', form.lastName);
        url.searchParams.set('checkout[shipping_address][first_name]', form.firstName);
        url.searchParams.set('checkout[shipping_address][zip]', form.zip);
        url.searchParams.set('checkout[shipping_address][province]', form.prefecture);
        url.searchParams.set('checkout[shipping_address][city]', form.city);
        url.searchParams.set('checkout[shipping_address][address1]', form.address1);
        url.searchParams.set('checkout[shipping_address][address2]', form.address2);
        url.searchParams.set('checkout[shipping_address][phone]', form.phone);
        url.searchParams.set('checkout[shipping_address][country]', 'JP');

        // Shopify 결제 후 복귀 URL에 원본 UTM 파라미터를 그대로 전달
        // GA4 _gl linker는 Shopify에 GA4 태그가 없어 작동하지 않으므로,
        // 방문 시 저장해둔 UTM을 return_to에 붙여 소스 귀속을 복원한다.
        const returnUrl = new URL(`${window.location.origin}/checkout-return`);
        try {
          const savedUtm = sessionStorage.getItem('_bm_utm');
          if (savedUtm) {
            const utmData = JSON.parse(savedUtm) as Record<string, string>;
            Object.entries(utmData).forEach(([k, v]) => { if (v) returnUrl.searchParams.set(k, v); });
          }
        } catch { /* ignore */ }
        const glParam = await getGA4LinkerParam();
        if (glParam) returnUrl.searchParams.set('_gl', glParam);
        url.searchParams.set('return_to', returnUrl.toString());

        // Shopify checkout URL에서 token 추출 (transaction_id로 사용)
        // 형식: /checkouts/cn/<TOKEN>/...
        const tokenMatch = checkoutUrl.match(/\/checkouts\/(?:cn\/)?([A-Za-z0-9]+)/);
        const checkoutToken = tokenMatch?.[1] ?? `co_${Date.now()}`;

        // CheckoutReturn에서 purchase 이벤트 발생을 위해 장바구니 정보 저장
        sessionStorage.setItem('checkout_pending', '1');
        sessionStorage.setItem('checkout_ga4', JSON.stringify({
          transactionId: checkoutToken,
          items: items.map(item => ({
            item_id: item.variantId,
            item_name: item.product.node.title,
            price: parseFloat(item.price.amount),
            currency: item.price.currencyCode,
            quantity: item.quantity,
          })),
          currency: items[0]?.price.currencyCode ?? 'JPY',
          value: subtotal + shipping,
          shipping,
        }));

        window.location.href = url.toString();
      }
    } catch (err) {
      console.error('Checkout error:', err);
      toast.error('決済ページへの移動に失敗しました。', { position: 'top-center' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-32">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background border-b border-border">
        <div className="max-w-lg mx-auto flex items-center px-4 h-14">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="flex-1 text-center font-semibold">お届け先情報</h1>
          <div className="w-9" />
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Order Summary */}
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-muted-foreground" />
            注文内容
          </h2>
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.variantId} className="flex items-center gap-3">
                {item.product.node.images?.edges?.[0]?.node && (
                  <img
                    src={item.product.node.images.edges[0].node.url}
                    alt={item.product.node.title}
                    className="w-12 h-12 rounded-lg object-cover"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{item.product.node.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.variantTitle !== 'Default Title' && item.selectedOptions.map((o) => o.value).join(' / ')}
                    {' '}x{item.quantity}
                  </p>
                  {(() => {
                    const preorderDate = getPreorderDate(item.product.node.tags ?? []);
                    if (!preorderDate) return null;
                    const [y, m, d] = preorderDate.split('-');
                    return (
                      <p className="text-[10px] text-amber-600 mt-0.5">🚚 {y}/{m}/{d} 発送予定</p>
                    );
                  })()}
                </div>
                <span className="text-sm font-semibold" translate="no">
                  {formatPrice((parseFloat(item.price.amount) * item.quantity).toString(), item.price.currencyCode)}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-border mt-3 pt-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">小計</span>
              <span translate="no">{formatPrice(subtotal.toString(), currencyCode)}</span>
            </div>
            {discountInfo && discountInfo.totalSavings > 0 && (
              <div className="flex justify-between text-sm text-red-500">
                <span className="font-medium">割引</span>
                <span translate="no">-{formatPrice(discountInfo.totalSavings.toFixed(2), discountInfo.currencyCode)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground flex items-center gap-1">
                <Truck className="h-3.5 w-3.5" />送料
              </span>
              <span translate="no">{shipping > 0 ? formatPrice(shipping.toString(), currencyCode) : '無料'}</span>
            </div>
            <div className="flex justify-between text-base font-bold pt-1 border-t border-border">
              <span>合計</span>
              <span translate="no">
                {discountInfo && discountInfo.totalSavings > 0
                  ? formatPrice((discountInfo.discountedTotal + shipping).toFixed(2), currencyCode)
                  : formatPrice(total.toString(), currencyCode)}
              </span>
            </div>
          </div>
        </div>

        {/* Preorder combined shipping notice */}
        {items.some(item => getPreorderDate(item.product.node.tags ?? [])) && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[11px] text-amber-800 leading-relaxed">
            <p className="font-semibold mb-0.5">⚠️ 予約商品が含まれるご注文について</p>
            <p>予約商品を含むご注文は、予約出荷日に合わせて全商品をまとめて発送いたします。通常商品を早急にお受け取り希望の場合は、お手数ですが別途ご購入ください。</p>
          </div>
        )}

        {/* Shipping Form - wrapped in <form> for browser autofill */}
        <form autoComplete="on" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            お届け先
          </h2>
          <div className="space-y-4">
            <div>
              <Label htmlFor="email">メールアドレス <span className="text-destructive">*</span></Label>
              <Input
                id="email" name="email" type="email" value={form.email}
                onChange={(e) => updateField('email', e.target.value)}
                placeholder="example@email.com"
                autoComplete="email"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="lastName">姓 <span className="text-destructive">*</span></Label>
                <Input id="lastName" name="family-name" value={form.lastName} onChange={(e) => updateField('lastName', e.target.value)} placeholder="山田" autoComplete="family-name" />
              </div>
              <div>
                <Label htmlFor="firstName">名</Label>
                <Input id="firstName" name="given-name" value={form.firstName} onChange={(e) => updateField('firstName', e.target.value)} placeholder="太郎" autoComplete="given-name" />
              </div>
            </div>

            <div>
              <Label htmlFor="zip">郵便番号 <span className="text-destructive">*</span></Label>
              <div className="flex gap-2">
                <Input
                  id="zip" name="postal-code" value={form.zip}
                  onChange={(e) => updateField('zip', e.target.value)}
                  onBlur={handleZipLookup}
                  placeholder="1000001"
                  maxLength={8}
                  className="flex-1"
                  autoComplete="postal-code"
                />
                <Button type="button" variant="outline" size="sm" onClick={handleZipLookup} className="flex-shrink-0">
                  住所検索
                </Button>
              </div>
            </div>

            <div>
              <Label htmlFor="prefecture">都道府県 <span className="text-destructive">*</span></Label>
              <select
                id="prefecture" name="address-level1" value={form.prefecture}
                onChange={(e) => updateField('prefecture', e.target.value)}
                autoComplete="address-level1"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">選択してください</option>
                {PREFECTURES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            <div>
              <Label htmlFor="city">市区町村 <span className="text-destructive">*</span></Label>
              <Input id="city" name="address-level2" value={form.city} onChange={(e) => updateField('city', e.target.value)} placeholder="千代田区" autoComplete="address-level2" />
            </div>

            <div>
              <Label htmlFor="address1">番地 <span className="text-destructive">*</span></Label>
              <Input id="address1" name="address-line1" value={form.address1} onChange={(e) => updateField('address1', e.target.value)} placeholder="丸の内1-1-1" autoComplete="address-line1" />
            </div>

            <div>
              <Label htmlFor="address2">建物名・部屋番号</Label>
              <Input id="address2" name="address-line2" value={form.address2} onChange={(e) => updateField('address2', e.target.value)} placeholder="〇〇マンション 101号室" autoComplete="address-line2" />
            </div>

            <div>
              <Label htmlFor="phone">電話番号</Label>
              <Input id="phone" name="tel" type="tel" value={form.phone} onChange={(e) => updateField('phone', e.target.value)} placeholder="09012345678" autoComplete="tel" />
            </div>
          </div>
        </form>
      </main>

      {/* Fixed bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-background border-t border-border p-4 z-40">
        <div className="max-w-lg mx-auto">
          <Button
            onClick={handleSubmit}
            disabled={!isFormValid || isSubmitting || isLoading}
            className="w-full h-12 text-base font-semibold"
          >
            {isSubmitting || isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                処理中...
              </>
            ) : (
              <>お支払いに進む — {formatPrice(total.toString(), currencyCode)}</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
