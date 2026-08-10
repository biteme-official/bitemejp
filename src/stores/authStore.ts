import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface LineUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  email?: string;
  shopifyCustomerToken?: string;
  shopifyEmail?: string;
  shopifyCustomerId?: string; // gid://shopify/Customer/xxx
  /**
   * /api/line-callback 이 서명해 발급한 세션 토큰.
   * 주문 조회·이메일 등록·토큰 재발급 API 의 인증 수단이며,
   * Storefront 토큰이 발급되지 않는 계정도 이걸로 본인 확인이 된다.
   */
  lineSessionToken?: string;
}

interface AuthStore {
  user: LineUserProfile | null;
  isLoggedIn: boolean;

  // Actions
  login: (user: LineUserProfile) => void;
  logout: () => void;
  updateCustomerToken: (token: string) => void;
  /**
   * 실제 이메일 등록 후 호출.
   * shopifyEmail 은 /api/refresh-customer-token 의 조회 키로 쓰이므로
   * 반드시 함께 갱신해야 체크아웃 직전 토큰 재발급이 깨지지 않는다.
   */
  updateEmail: (email: string, customerAccessToken?: string | null) => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      isLoggedIn: false,

      login: (user) => set({ user, isLoggedIn: true }),
      logout: () => set({ user: null, isLoggedIn: false }),
      updateCustomerToken: (token) =>
        set((state) => ({
          user: state.user ? { ...state.user, shopifyCustomerToken: token } : state.user,
        })),
      updateEmail: (email, customerAccessToken) =>
        set((state) => ({
          user: state.user
            ? {
                ...state.user,
                email,
                shopifyEmail: email,
                ...(customerAccessToken ? { shopifyCustomerToken: customerAccessToken } : {}),
              }
            : state.user,
        })),
    }),
    {
      name: 'line-auth',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
