import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface WishlistItem {
  productId: string;
  handle: string;
  title: string;
  imageUrl?: string;
  price: string;
  currencyCode: string;
}

interface WishlistStore {
  items: WishlistItem[];
  addItem: (item: WishlistItem) => void;
  removeItem: (productId: string) => void;
  isWishlisted: (productId: string) => boolean;
  toggleItem: (item: WishlistItem) => void;
}

export const useWishlistStore = create<WishlistStore>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (item) => {
        const { items } = get();
        if (!items.find(i => i.productId === item.productId)) {
          set({ items: [...items, item] });
        }
      },

      removeItem: (productId) => {
        set({ items: get().items.filter(i => i.productId !== productId) });
      },

      isWishlisted: (productId) => {
        return get().items.some(i => i.productId === productId);
      },

      toggleItem: (item) => {
        const { isWishlisted, addItem, removeItem } = get();
        if (isWishlisted(item.productId)) {
          removeItem(item.productId);
        } else {
          addItem(item);
        }
      },
    }),
    {
      name: 'bite-me-wishlist',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
