/**
 * 재입고 LINE 알림 UI (#219). 신청 로직은 `stores/restockStore.ts` 한 곳에 있다.
 *
 *   - RestockNotifyButton  상품 상세 하단 — 고른 옵션이 품절일 때 「カートに入れる / すぐ購入」 자리를 대신한다
 *   - RestockCardButton    목록 카드 — 「SOLD OUT」 아래 「再入荷通知」
 *   - RestockCenter        App 에 한 번 — 로그인 갔다 온 뒤 자동 신청, 옵션 고르기·친구추가 시트
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import {
  RESTOCK_PARAM,
  RESTOCK_PRODUCT_PARAM,
  numericId,
  useRestockStore,
  type RestockProduct,
} from "@/stores/restockStore";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

const LINE_FRIEND_URL = "https://line.me/R/ti/p/@621txosw";

/** 상품 상세 하단 버튼 */
export function RestockNotifyButton({ product, variantId }: { product: RestockProduct; variantId: string }) {
  const { subscribed, submitting, request } = useRestockStore();
  const done = subscribed.includes(variantId);
  const busy = submitting === variantId;

  return (
    <button
      onClick={() => request(product, variantId)}
      disabled={busy}
      className={
        done
          ? "flex-1 h-12 rounded-lg border border-[#06C755] text-[#06C755] font-semibold text-sm flex items-center justify-center gap-2"
          : "flex-1 h-12 rounded-lg bg-[#06C755] text-white font-semibold text-sm flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-60"
      }
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : done ? <BellRing className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
      {done ? "再入荷通知 登録済み" : "再入荷をLINEで受け取る"}
    </button>
  );
}

/**
 * 목록 카드 — 품절 오버레이 안에 둔다. 카드 전체가 상품 링크(stretched link)라 z-10 으로 위에 올리고
 * 클릭이 링크로 새지 않게 막는다.
 */
export function RestockCardButton({ product, size = "md" }: { product: RestockProduct; size?: "sm" | "md" }) {
  const { subscribed, submitting, request } = useRestockStore();
  if (product.soldOutVariants.length === 0) return null;
  // 옵션이 여럿이면 전부 신청했을 때만 「登録済み」
  const done = product.soldOutVariants.every((v) => subscribed.includes(v.id));
  const busy = !!submitting && product.soldOutVariants.some((v) => v.id === submitting);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        track("restock_card_click", { product_id: numericId(product.id) });
        request(product);
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
      {done ? "通知登録済み" : "再入荷通知"}
    </button>
  );
}

/** App 에 한 번 둔다 */
export function RestockCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, isLoggedIn } = useAuthStore();
  const token = isLoggedIn ? user?.lineSessionToken : undefined;
  const { sheet, closeSheet, request, subscribe, subscribed } = useRestockStore();
  const autoDone = useRef(false);

  // LINE 로그인에서 돌아오면(?restock=<옵션>&restock_p=<상품>) 자동 신청하고 표식을 지운다
  useEffect(() => {
    const v = searchParams.get(RESTOCK_PARAM);
    const p = searchParams.get(RESTOCK_PRODUCT_PARAM);
    if (!v || !p || !token || autoDone.current) return;
    if (!/^\d+$/.test(v) || !/^\d+$/.test(p)) return;
    autoDone.current = true;
    const next = new URLSearchParams(searchParams);
    next.delete(RESTOCK_PARAM);
    next.delete(RESTOCK_PRODUCT_PARAM);
    setSearchParams(next, { replace: true });
    void subscribe(`gid://shopify/Product/${p}`, `gid://shopify/ProductVariant/${v}`);
  }, [searchParams, token, setSearchParams, subscribe]);

  return (
    <Drawer open={!!sheet} onOpenChange={(o) => !o && closeSheet()}>
      <DrawerContent>
        <div className="mx-auto w-full max-w-md px-4 pb-6">
          {sheet?.kind === "pick" ? (
            <>
              <DrawerHeader className="px-0 text-left">
                <DrawerTitle>再入荷通知を受け取る</DrawerTitle>
                <DrawerDescription>{sheet.product.title}</DrawerDescription>
              </DrawerHeader>
              <p className="text-xs text-muted-foreground mb-2">お知らせを受け取るオプションを選んでください</p>
              <div className="flex flex-wrap gap-2">
                {sheet.product.soldOutVariants.map((v) => {
                  const done = subscribed.includes(v.id);
                  return (
                    <button
                      key={v.id}
                      disabled={done}
                      onClick={() => request(sheet.product, v.id)}
                      className={cn(
                        "px-3 py-2 rounded-md border text-sm",
                        done ? "border-[#06C755] text-[#06C755]" : "border-border hover:border-[#06C755]",
                      )}
                    >
                      {done && <BellRing className="inline h-3.5 w-3.5 mr-1" />}
                      {v.title || sheet.product.title}
                    </button>
                  );
                })}
              </div>
              {!token && <p className="text-[11px] text-muted-foreground mt-3">LINEでログイン後、この画面に戻って登録されます</p>}
            </>
          ) : (
            <>
              <DrawerHeader className="px-0 text-left">
                <DrawerTitle>再入荷通知を登録しました</DrawerTitle>
                <DrawerDescription>
                  お知らせはBITE ME JAPANのLINE公式アカウントからお送りします。
                  友だち追加がまだの方は、下のボタンから追加してください。
                </DrawerDescription>
              </DrawerHeader>
              <a
                href={LINE_FRIEND_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track("restock_friend_click", {})}
                className="flex items-center justify-center w-full px-4 py-3 rounded-md text-white font-medium text-sm bg-[#06C755] hover:opacity-90"
              >
                LINEで友だち追加する
              </a>
              <p className="text-[11px] text-muted-foreground text-center mt-2">再入荷のお知らせは1回のみお送りします</p>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
