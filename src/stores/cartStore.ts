import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ShopifyProduct, createStorefrontCheckout, fetchProductByHandle } from '@/lib/shopify';
import { GIFT_THRESHOLD, GIFT_PRODUCT_HANDLE } from '@/config/giftConfig';

export interface CartItem {
  product: ShopifyProduct;
  variantId: string;
  variantTitle: string;
  price: {
    amount: string;
    currencyCode: string;
  };
  quantity: number;
  quantityAvailable: number | null;
  selectedOptions: Array<{
    name: string;
    value: string;
  }>;
  isGift?: boolean;
}

// Fetched once per session; avoids repeated API calls
let _giftItemTemplate: CartItem | null = null;
let _giftSyncing = false;

function buildGiftCartItem(productNode: ShopifyProduct['node']): CartItem | null {
  const variant = productNode.variants.edges[0]?.node;
  if (!variant) return null;
  return {
    product: { node: productNode },
    variantId: variant.id,
    variantTitle: variant.title,
    price: { amount: '0', currencyCode: 'JPY' },
    quantity: 1,
    quantityAvailable: null,
    selectedOptions: variant.selectedOptions,
    isGift: true,
  };
}

interface CartStore {
  items: CartItem[];
  cartId: string | null;
  checkoutUrl: string | null;
  isLoading: boolean;

  addItem: (item: CartItem) => void;
  updateQuantity: (variantId: string, quantity: number) => void;
  removeItem: (variantId: string) => void;
  clearCart: () => void;
  setCartId: (cartId: string) => void;
  setCheckoutUrl: (url: string) => void;
  setLoading: (loading: boolean) => void;
  syncGiftItem: () => Promise<void>;
  createCheckout: (lineItems?: { variantId: string; quantity: number }[], email?: string) => Promise<string | null>;
  getTotalItems: () => number;
  getTotalPrice: () => number;
}

export const useCartStore = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],
      cartId: null,
      checkoutUrl: null,
      isLoading: false,

      addItem: (item) => {
        if (item.isGift) return;

        const { items } = get();
        const existingItem = items.find(i => i.variantId === item.variantId && !i.isGift);

        if (existingItem) {
          const newQuantity = existingItem.quantity + item.quantity;
          const maxQuantity = item.quantityAvailable ?? Infinity;
          const finalQuantity = Math.min(newQuantity, maxQuantity);
          set({
            items: items.map(i =>
              i.variantId === item.variantId && !i.isGift
                ? { ...i, quantity: finalQuantity, quantityAvailable: item.quantityAvailable }
                : i
            )
          });
        } else {
          const maxQuantity = item.quantityAvailable ?? Infinity;
          const finalQuantity = Math.min(item.quantity, maxQuantity);
          set({ items: [...items, { ...item, quantity: finalQuantity }] });
        }

        get().syncGiftItem();
      },

      updateQuantity: (variantId, quantity) => {
        const item = get().items.find(i => i.variantId === variantId);
        if (item?.isGift) return;

        if (quantity <= 0) {
          get().removeItem(variantId);
          return;
        }

        if (!item) return;

        const maxQuantity = item.quantityAvailable ?? Infinity;
        const finalQuantity = Math.min(quantity, maxQuantity);

        set({
          items: get().items.map(i =>
            i.variantId === variantId && !i.isGift ? { ...i, quantity: finalQuantity } : i
          )
        });

        get().syncGiftItem();
      },

      removeItem: (variantId) => {
        const item = get().items.find(i => i.variantId === variantId);
        if (item?.isGift) return;

        set({ items: get().items.filter(i => !(i.variantId === variantId && !i.isGift)) });

        get().syncGiftItem();
      },

      clearCart: () => {
        set({ items: [], cartId: null, checkoutUrl: null });
      },

      setCartId: (cartId) => set({ cartId }),
      setCheckoutUrl: (checkoutUrl) => set({ checkoutUrl }),
      setLoading: (isLoading) => set({ isLoading }),

      syncGiftItem: async () => {
        if (_giftSyncing) return;
        _giftSyncing = true;

        try {
          const { items } = get();
          const nonGiftTotal = items
            .filter(i => !i.isGift)
            .reduce((sum, i) => sum + parseFloat(i.price.amount) * i.quantity, 0);

          const hasGift = items.some(i => i.isGift);
          const shouldHaveGift = nonGiftTotal >= GIFT_THRESHOLD;

          if (shouldHaveGift && !hasGift) {
            if (!_giftItemTemplate) {
              const product = await fetchProductByHandle(GIFT_PRODUCT_HANDLE);
              if (!product) return;
              _giftItemTemplate = buildGiftCartItem(product);
            }
            if (_giftItemTemplate) {
              const { items: latest } = get();
              if (!latest.some(i => i.isGift)) {
                set({ items: [...latest, _giftItemTemplate] });
              }
            }
          } else if (!shouldHaveGift && hasGift) {
            set({ items: get().items.filter(i => !i.isGift) });
          }
        } finally {
          _giftSyncing = false;
        }
      },

      createCheckout: async (lineItems, email) => {
        const { items, setLoading, setCheckoutUrl } = get();
        const checkoutItems = lineItems ?? items.map(item => ({
          variantId: item.variantId,
          quantity: item.quantity,
        }));
        if (checkoutItems.length === 0) return null;

        setLoading(true);
        try {
          const checkoutUrl = await createStorefrontCheckout(checkoutItems, email);
          setCheckoutUrl(checkoutUrl);
          return checkoutUrl;
        } catch (error) {
          console.error('Failed to create checkout:', error);
          return null;
        } finally {
          setLoading(false);
        }
      },

      getTotalItems: () => {
        return get().items.filter(i => !i.isGift).reduce((sum, item) => sum + item.quantity, 0);
      },

      getTotalPrice: () => {
        return get().items.filter(i => !i.isGift).reduce((sum, item) => sum + (parseFloat(item.price.amount) * item.quantity), 0);
      },
    }),
    {
      name: 'shopify-cart',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        items: state.items,
        cartId: state.cartId,
        checkoutUrl: state.checkoutUrl,
      }),
    }
  )
);
