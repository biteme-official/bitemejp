/**
 * 재입고 LINE 알림 신청 (#219) — 상품 상세 하단 버튼과 목록 카드 버튼이 같이 쓴다.
 *
 * 신청 흐름
 *   - LINE 로그인 고객 → /api/line-restock POST 로 바로 신청
 *   - 비로그인        → LINE 로그인 → 보던 화면으로 돌아와(?restock=<옵션>&restock_p=<상품>)
 *                       `RestockCenter` 가 자동 신청
 *   - 공식계정 친구가 아니면 친구추가 안내 시트. 친구가 아니면 LINE 메시지가 닿지 않는다
 *
 * 신청한 옵션은 이 브라우저에 기억해 「登録済み」로 보여준다(서버도 중복 신청은 한 건으로 친다).
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/authStore";
import { initiateLineLogin } from "@/lib/line-auth";
import { track } from "@/lib/track";

/** 로그인 후 돌아왔을 때 자동 신청할 옵션 id (숫자) */
export const RESTOCK_PARAM = "restock";
/** 같이 실어 보내는 상품 id (숫자) — 목록에서 신청하면 상품 페이지가 아니라서 따로 필요하다 */
export const RESTOCK_PRODUCT_PARAM = "restock_p";

export const numericId = (gid: string) => gid.split("/").pop() ?? "";

export interface RestockVariant {
  id: string;
  title: string;
}

export interface RestockProduct {
  id: string;
  title: string;
  /** 품절인 옵션들. 하나면 바로 신청, 여럿이면 고르는 시트를 띄운다 */
  soldOutVariants: RestockVariant[];
}

interface RestockStore {
  /** 신청한 옵션 gid */
  subscribed: string[];
  submitting: string | null;
  /** 열려 있는 시트 */
  sheet: { kind: "friend" } | { kind: "pick"; product: RestockProduct } | null;
  closeSheet: () => void;
  /** 카드·버튼이 부르는 입구. 옵션을 아직 안 골랐으면(여럿) 고르는 시트를 연다 */
  request: (product: RestockProduct, variantId?: string) => void;
  /** 실제 신청 (로그인 상태에서) */
  subscribe: (productId: string, variantId: string) => Promise<void>;
}

export const useRestockStore = create<RestockStore>()(
  persist(
    (set, get) => ({
      subscribed: [],
      submitting: null,
      sheet: null,
      closeSheet: () => set({ sheet: null }),

      request: (product, variantId) => {
        const target = variantId ?? (product.soldOutVariants.length === 1 ? product.soldOutVariants[0].id : undefined);
        if (!target) {
          set({ sheet: { kind: "pick", product } });
          return;
        }
        if (get().subscribed.includes(target)) {
          set({ sheet: { kind: "friend" } });
          return;
        }
        const { user, isLoggedIn } = useAuthStore.getState();
        if (!isLoggedIn || !user?.lineSessionToken) {
          const next = new URLSearchParams(window.location.search);
          next.set(RESTOCK_PARAM, numericId(target));
          next.set(RESTOCK_PRODUCT_PARAM, numericId(product.id));
          track("restock_login_click", { product_id: numericId(product.id), variant_id: numericId(target) });
          initiateLineLogin({ returnTo: `${window.location.pathname}?${next.toString()}`, src: "button" })
            .catch(() => toast.error("LINEログインを開始できませんでした"));
          return;
        }
        set({ sheet: null });
        void get().subscribe(product.id, target);
      },

      subscribe: async (productId, variantId) => {
        const { user, isLoggedIn, logout } = useAuthStore.getState();
        const token = isLoggedIn ? user?.lineSessionToken : undefined;
        if (!token || get().submitting) return;
        set({ submitting: variantId });
        try {
          const res = await fetch("/api/line-restock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lineSessionToken: token, productId, variantId }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string; friend?: boolean | null };
          if (res.status === 401) {
            logout();
            toast.error("ログインの有効期限が切れました。もう一度LINEでログインしてください。");
            return;
          }
          if (body.error === "in_stock") {
            toast.success("この商品は現在ご購入いただけます。ページを再読み込みしてください。");
            return;
          }
          if (!res.ok) {
            toast.error("登録できませんでした。時間をおいて再度お試しください。");
            return;
          }
          set((s) => ({ subscribed: [...s.subscribed.filter((v) => v !== variantId), variantId].slice(-100) }));
          track("restock_subscribe", { product_id: numericId(productId), variant_id: numericId(variantId), friend: body.friend ?? undefined });
          if (body.friend === false) set({ sheet: { kind: "friend" } });
          else toast.success("再入荷したらLINEでお知らせします", { position: "top-center" });
        } catch {
          toast.error("登録できませんでした。時間をおいて再度お試しください。");
        } finally {
          set({ submitting: null });
        }
      },
    }),
    {
      name: "restock_subs_v2",
      storage: createJSONStorage(() => localStorage),
      // 신청 목록만 기억한다. 시트·진행 상태는 새로고침하면 닫혀야 한다
      partialize: (s) => ({ subscribed: s.subscribed }),
    },
  ),
);

/** 목록 카드용 — 상품의 품절 옵션을 뽑는다 */
export function toRestockProduct(node: {
  id: string;
  title: string;
  variants: { edges: { node: { id: string; title: string; availableForSale: boolean } }[] };
}): RestockProduct {
  return {
    id: node.id,
    title: node.title,
    soldOutVariants: node.variants.edges
      .filter((e) => !e.node.availableForSale)
      .map((e) => ({ id: e.node.id, title: e.node.title === "Default Title" ? "" : e.node.title })),
  };
}
