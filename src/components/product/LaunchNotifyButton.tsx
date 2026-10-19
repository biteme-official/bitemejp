/**
 * 출시 예정 상품 오픈 LINE 알림 UI (#248). 신청 로직은 `stores/launchStore.ts` 한 곳에 있다.
 * 재입고 알림(`RestockNotifyButton.tsx`)과 같은 모양이고, 옵션 대신 상품 단위로 신청한다.
 *
 *   - LaunchNotifyButton  상품 상세 하단 — 「カートに入れる / すぐ購入」 자리를 대신한다
 *   - LaunchCardButton    목록 카드 — 「COMING SOON」 아래 「発売通知」
 *   - LaunchCenter        App 에 한 번 — 로그인 갔다 온 뒤 자동 신청, 친구추가 시트
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { LAUNCH_PARAM, useLaunchStore } from "@/stores/launchStore";
import { numericId } from "@/stores/restockStore";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

const LINE_FRIEND_URL = "https://line.me/R/ti/p/@621txosw";

/** 상품 상세 하단 버튼 */
export function LaunchNotifyButton({ productId }: { productId: string }) {
  const { subscribed, submitting, request } = useLaunchStore();
  const done = subscribed.includes(productId);
  const busy = submitting === productId;

  return (
    <button
      onClick={() => request(productId)}
      disabled={busy}
      className={
        done
          ? "flex-1 h-12 rounded-lg border border-[#06C755] text-[#06C755] font-semibold text-sm flex items-center justify-center gap-2"
          : "flex-1 h-12 rounded-lg bg-[#06C755] text-white font-semibold text-sm flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-60"
      }
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : done ? <BellRing className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
      {done ? "発売通知 登録済み" : "発売をLINEで受け取る"}
    </button>
  );
}

/**
 * 목록 카드 — 「COMING SOON」 오버레이 안에 둔다. 카드 전체가 상품 링크(stretched link)라 z-10 으로 위에 올리고
 * 클릭이 링크로 새지 않게 막는다.
 */
export function LaunchCardButton({ productId, size = "md" }: { productId: string; size?: "sm" | "md" }) {
  const { subscribed, submitting, request } = useLaunchStore();
  const done = subscribed.includes(productId);
  const busy = submitting === productId;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        track("launch_card_click", { product_id: numericId(productId) });
        request(productId);
      }}
      disabled={busy}
      className={cn(
        "relative z-10 inline-flex items-center gap-1 rounded-full font-bold shadow-sm whitespace-nowrap",
        size === "sm" ? "px-2 py-1 text-[10px]" : "px-3 py-1.5 text-xs",
        done ? "bg-white text-[#06C755] border border-[#06C755]" : "bg-[#06C755] text-white hover:opacity-90",
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : done ? (
        <BellRing className="h-3.5 w-3.5" />
      ) : (
        <Bell className="h-3.5 w-3.5" />
      )}
      {done ? "通知登録済み" : "発売通知"}
    </button>
  );
}

/** App 에 한 번 둔다 */
export function LaunchCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, isLoggedIn } = useAuthStore();
  const token = isLoggedIn ? user?.lineSessionToken : undefined;
  const { friendSheet, closeSheet, subscribe } = useLaunchStore();
  const autoDone = useRef(false);

  // LINE 로그인에서 돌아오면(?launch=<상품>) 자동 신청하고 표식을 지운다
  useEffect(() => {
    const p = searchParams.get(LAUNCH_PARAM);
    if (!p || !token || autoDone.current) return;
    if (!/^\d+$/.test(p)) return;
    autoDone.current = true;
    const next = new URLSearchParams(searchParams);
    next.delete(LAUNCH_PARAM);
    setSearchParams(next, { replace: true });
    void subscribe(`gid://shopify/Product/${p}`);
  }, [searchParams, token, setSearchParams, subscribe]);

  return (
    <Drawer open={friendSheet} onOpenChange={(o) => !o && closeSheet()}>
      <DrawerContent>
        <div className="mx-auto w-full max-w-md px-4 pb-6">
          <DrawerHeader className="px-0 text-left">
            <DrawerTitle>発売通知を登録しました</DrawerTitle>
            <DrawerDescription>
              お知らせはBITE ME JAPANのLINE公式アカウントからお送りします。
              友だち追加がまだの方は、下のボタンから追加してください。
            </DrawerDescription>
          </DrawerHeader>
          <a
            href={LINE_FRIEND_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track("launch_friend_click", {})}
            className="flex items-center justify-center w-full px-4 py-3 rounded-md text-white font-medium text-sm bg-[#06C755] hover:opacity-90"
          >
            LINEで友だち追加する
          </a>
          <p className="text-[11px] text-muted-foreground text-center mt-2">発売のお知らせは1回のみお送りします</p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
