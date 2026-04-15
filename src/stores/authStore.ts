import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface LineUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  email?: string;
  shopifyCustomerToken?: string;
  shopifyEmail?: string;
}

interface AuthStore {
  user: LineUserProfile | null;
  isLoggedIn: boolean;

  // Actions
  login: (user: LineUserProfile) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      isLoggedIn: false,

      login: (user) => set({ user, isLoggedIn: true }),
      logout: () => set({ user: null, isLoggedIn: false }),
    }),
    {
      name: 'line-auth',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
