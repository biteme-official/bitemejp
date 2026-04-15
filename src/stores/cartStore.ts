import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ShopifyProduct, createStorefrontCheckout } from '@/lib/shopify';

export interface CartItem {
  product: ShopifyProduct;
  variantId: string;
  variantTitle: string;
  price: {
    amount: string;
    currencyCode: string;
  };
  quantity: number;
  quantityAvailable: number | null; // Track available stock
  selectedOptions: Array<{
    name: string;
    value: string;
  }>;
}

interface CartStore {
  items: CartItem[];
  cartId: string | null;
  checkoutUrl: string | null;
  isLoading: boolean;

  // Actions
  addItem: (item: CartItem) => void;
  updateQuantity: (variantId: string, quantity: number) => void;
  removeItem: (variantId: string) => void;
  clearCart: () => void;
  setCartId: (cartId: string) => void;
  setCheckoutUrl: (url: string) => void;
  setLoading: (loading: boolean) => void;
  createCheckout: (lineItems?: { variantId: string; quantity: number }[]) => Promise<string | null>;
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
        const { items } = get();
        const existingItem = items.find(i => i.variantId === item.variantId);

        if (existingItem) {
          // Check stock limit when adding to existing item
          const newQuantity = existingItem.quantity + item.quantity;
          const maxQuantity = item.quantityAvailable ?? Infinity;
          const finalQuantity = Math.min(newQuantity, maxQuantity);

          set({
            items: items.map(i =>
              i.variantId === item.variantId
                ? { ...i, quantity: finalQuantity, quantityAvailable: item.quantityAvailable }
                : i
            )
          });
        } else {
          // Check stock limit for new item
          const maxQuantity = item.quantityAvailable ?? Infinity;
          const finalQuantity = Math.min(item.quantity, maxQuantity);
          set({ items: [...items, { ...item, quantity: finalQuantity }] });
        }
      },

      updateQuantity: (variantId, quantity) => {
        if (quantity <= 0) {
          get().removeItem(variantId);
          return;
        }

        const item = get().items.find(i => i.variantId === variantId);
        if (!item) return;

        // Check stock limit
        const maxQuantity = item.quantityAvailable ?? Infinity;
        const finalQuantity = Math.min(quantity, maxQuantity);

        set({
          items: get().items.map(i =>
            i.variantId === variantId ? { ...i, quantity: finalQuantity } : i
          )
        });
      },

      removeItem: (variantId) => {
        set({
          items: get().items.filter(item => item.variantId !== variantId)
        });
      },

      clearCart: () => {
        set({ items: [], cartId: null, checkoutUrl: null });
      },

      setCartId: (cartId) => set({ cartId }),
      setCheckoutUrl: (checkoutUrl) => set({ checkoutUrl }),
      setLoading: (isLoading) => set({ isLoading }),

      createCheckout: async (lineItems) => {
        const { items, setLoading, setCheckoutUrl } = get();
        const checkoutItems = lineItems ?? items.map(item => ({
          variantId: item.variantId,
          quantity: item.quantity,
        }));
        if (checkoutItems.length === 0) return null;

        setLoading(true);
        try {
          const checkoutUrl = await createStorefrontCheckout(checkoutItems);
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
        return get().items.length;
      },

      getTotalPrice: () => {
        return get().items.reduce((sum, item) => sum + (parseFloat(item.price.amount) * item.quantity), 0);
      },
    }),
    {
      name: 'shopify-cart',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
