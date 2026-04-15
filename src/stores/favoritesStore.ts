import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface FavoritesStore {
  // Map of LINE userId → Set of product handles
  favorites: Record<string, string[]>;

  // Actions
  addFavorite: (userId: string, productHandle: string) => void;
  removeFavorite: (userId: string, productHandle: string) => void;
  isFavorite: (userId: string, productHandle: string) => boolean;
  getFavorites: (userId: string) => string[];
}

export const useFavoritesStore = create<FavoritesStore>()(
  persist(
    (set, get) => ({
      favorites: {},

      addFavorite: (userId, productHandle) =>
        set((state) => {
          const current = state.favorites[userId] || [];
          if (current.includes(productHandle)) return state;
          return {
            favorites: { ...state.favorites, [userId]: [...current, productHandle] },
          };
        }),

      removeFavorite: (userId, productHandle) =>
        set((state) => {
          const current = state.favorites[userId] || [];
          return {
            favorites: { ...state.favorites, [userId]: current.filter((h) => h !== productHandle) },
          };
        }),

      isFavorite: (userId, productHandle) => {
        const current = get().favorites[userId] || [];
        return current.includes(productHandle);
      },

      getFavorites: (userId) => get().favorites[userId] || [],
    }),
    {
      name: 'shopify-favorites',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
