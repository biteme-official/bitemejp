/**
 * 상품 상세 하단 — 고른 옵션이 품절일 때 「カートに入れる / すぐ購入」 자리를 대신한다 (#219).
 *
 *   - LINE 로그인 고객 → 누르면 바로 신청(/api/line-restock POST)
 *   - 비로그인        → LINE 로그인 → 이 상품 페이지로 돌아와(?restock=<옵션id>) 자동 신청
 *   - 공식계정 친구가 아니면 → 친구추가 안내. 친구가 아니면 LINE 메시지가 닿지 않는다
 *
 * 신청한 옵션은 이 브라우저에 기억해 「登録済み」로 보여준다(서버도 중복 신청은 한 건으로 친다).
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/authStore";
import { initiateLineLogin } from "@/lib/line-auth";
import { track } from "@/lib/track";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

/** 로그인 후 돌아왔을 때 자동 신청할 옵션 id (숫자) */
export const RESTOCK_PARAM = "restock";
const STORAGE_KEY = "restock_subs_v1";
const LINE_FRIEND_URL = "https://line.me/R/ti/p/@621txosw";

function readSubscribed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function rememberSubscribed(variantId: string) {
  try {
    const list = readSubscribed().filter((v) => v !== variantId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...list, variantId].slice(-100)));
  } catch { /* 무시 */ }
}

const numericId = (gid: string) => gid.split("/").pop() ?? "";

interface Props {
  productId: string;
  /** 지금 고른(품절) 옵션 */
  variantId: string;
  /** 로그인 갔다 온 경우 자동 신청할 옵션을 찾기 위한 전체 옵션 id */
  variantIds: string[];
}

export function RestockNotifyButton({ productId, variantId, variantIds }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, isLoggedIn, logout } = useAuthStore();
  const token = isLoggedIn ? user?.lineSessionToken : undefined;
  const [subscribed, setSubscribed] = useState<string[]>(readSubscribed);
  const [submitting, setSubmitting] = useState(false);
  const [friendSheet, setFriendSheet] = useState(false);
  const autoDone = useRef(false);

  const subscribe = async (target: string) => {
    if (!token || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/line-restock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineSessionToken: token, productId, variantId: target }),
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
      rememberSubscribed(target);
      setSubscribed(readSubscribed());
      track("restock_subscribe", { product_id: numericId(productId), variant_id: numericId(target), friend: body.friend ?? undefined });
      if (body.friend === false) {
        setFriendSheet(true);
      } else {
        toast.success("再入荷したらLINEでお知らせします", { position: "top-center" });
      }
    } catch {
      toast.error("登録できませんでした。時間をおいて再度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

  // LINE 로그인에서 돌아오면(?restock=<옵션id>) 그 옵션으로 자동 신청하고 표식을 지운다
  useEffect(() => {
    const wanted = searchParams.get(RESTOCK_PARAM);
    if (!wanted || !token || autoDone.current) return;
    autoDone.current = true;
    const target = variantIds.find((id) => numericId(id) === wanted);
    const next = new URLSearchParams(searchParams);
    next.delete(RESTOCK_PARAM);
    setSearchParams(next, { replace: true });
    if (target) void subscribe(target);
    // subscribe 는 매 렌더 새로 만들어지지만 한 번만 돌면 된다(autoDone)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, token, variantIds]);

  const startLogin = () => {
    const next = new URLSearchParams(window.location.search);
    next.set(RESTOCK_PARAM, numericId(variantId));
    track("restock_login_click", { product_id: numericId(productId), variant_id: numericId(variantId) });
    initiateLineLogin({ returnTo: `${window.location.pathname}?${next.toString()}`, src: "button" })
      .catch(() => toast.error("LINEログインを開始できませんでした"));
  };

  const done = subscribed.includes(variantId);

  return (
    <>
      <button
        onClick={() => (done ? setFriendSheet(true) : token ? subscribe(variantId) : startLogin())}
        disabled={submitting}
        className={
          done
            ? "flex-1 h-12 rounded-lg border border-[#06C755] text-[#06C755] font-semibold text-sm flex items-center justify-center gap-2"
            : "flex-1 h-12 rounded-lg bg-[#06C755] text-white font-semibold text-sm flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-60"
        }
      >
        {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : done ? <BellRing className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
        {done ? "再入荷通知 登録済み" : "再入荷をLINEで受け取る"}
      </button>

      <Drawer open={friendSheet} onOpenChange={setFriendSheet}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-md px-4 pb-6">
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
              onClick={() => track("restock_friend_click", { product_id: numericId(productId) })}
              className="flex items-center justify-center w-full px-4 py-3 rounded-md text-white font-medium text-sm bg-[#06C755] hover:opacity-90"
            >
              LINEで友だち追加する
            </a>
            <p className="text-[11px] text-muted-foreground text-center mt-2">
              再入荷のお知らせは1回のみお送りします
            </p>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
