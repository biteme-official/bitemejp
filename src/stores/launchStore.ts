/**
 * 출시 예정 상품 오픈 LINE 알림 신청 (#248) — 상품 상세 하단 버튼과 목록 카드 버튼이 같이 쓴다.
 * 재입고 알림(`restockStore.ts`)과 같은 흐름이고, 옵션 대신 **상품 단위**로 신청한다.
 *
 * 신청 흐름
 *   - LINE 로그인 고객 → /api/line-launch POST 로 바로 신청
 *   - 비로그인        → LINE 로그인 → 보던 화면으로 돌아와(?launch=<상품>) `LaunchCenter` 가 자동 신청
 *   - 공식계정 친구가 아니면 친구추가 안내 시트. 친구가 아니면 LINE 메시지가 닿지 않는다
 *
 * 신청한 상품은 이 브라우저에 기억해 「登録済み」로 보여준다(서버도 중복 신청은 한 건으로 친다).
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/authStore";
import { initiateLineLogin } from "@/lib/line-auth";
import { track } from "@/lib/track";
import { numericId } from "@/stores/restockStore";

/** 로그인 후 돌아왔을 때 자동 신청할 상품 id (숫자) */
export const LAUNCH_PARAM = "launch";

interface LaunchStore {
  /** 신청한 상품 gid */
  subscribed: string[];
  submitting: string | null;
  /** 친구추가 안내 시트 */
  friendSheet: boolean;
  closeSheet: () => void;
  /** 카드·버튼이 부르는 입구 */
  request: (productId: string) => void;
  /** 실제 신청 (로그인 상태에서) */
  subscribe: (productId: string) => Promise<void>;
}

export const useLaunchStore = create<LaunchStore>()(
  persist(
    (set, get) => ({
      subscribed: [],
      submitting: null,
      friendSheet: false,
      closeSheet: () => set({ friendSheet: false }),

      request: (productId) => {
        if (get().subscribed.includes(productId)) {
          set({ friendSheet: true });
          return;
        }
        const { user, isLoggedIn } = useAuthStore.getState();
        if (!isLoggedIn || !user?.lineSessionToken) {
          const next = new URLSearchParams(window.location.search);
          next.set(LAUNCH_PARAM, numericId(productId));
          track("launch_login_click", { product_id: numericId(productId) });
          initiateLineLogin({ returnTo: `${window.location.pathname}?${next.toString()}`, src: "button" })
            .catch(() => toast.error("LINEログインを開始できませんでした"));
          return;
        }
        void get().subscribe(productId);
      },

      subscribe: async (productId) => {
        const { user, isLoggedIn, logout } = useAuthStore.getState();
        const token = isLoggedIn ? user?.lineSessionToken : undefined;
        if (!token || get().submitting) return;
        set({ submitting: productId });
        try {
          const res = await fetch("/api/line-launch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lineSessionToken: token, productId }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string; friend?: boolean | null };
          if (res.status === 401) {
            logout();
            toast.error("ログインの有効期限が切れました。もう一度LINEでログインしてください。");
            return;
          }
          if (body.error === "on_sale") {
            toast.success("この商品は販売が始まりました。ページを再読み込みしてください。");
            return;
          }
          if (!res.ok) {
            toast.error("登録できませんでした。時間をおいて再度お試しください。");
            return;
          }
          set((s) => ({ subscribed: [...s.subscribed.filter((p) => p !== productId), productId].slice(-100) }));
          track("launch_subscribe", { product_id: numericId(productId), friend: body.friend ?? undefined });
          if (body.friend === false) set({ friendSheet: true });
          else toast.success("発売したらLINEでお知らせします", { position: "top-center" });
        } catch {
          toast.error("登録できませんでした。時間をおいて再度お試しください。");
        } finally {
          set({ submitting: null });
        }
      },
    }),
    {
      name: "launch_subs_v1",
      storage: createJSONStorage(() => localStorage),
      // 신청 목록만 기억한다. 시트·진행 상태는 새로고침하면 닫혀야 한다
      partialize: (s) => ({ subscribed: s.subscribed }),
    },
  ),
);
