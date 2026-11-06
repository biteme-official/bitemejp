/**
 * /bf — 블랙프라이데이 「LINE 友だち限定 +5%OFF」 쿠폰 받기 (#274)
 *
 *   비로그인 → LINE 로그인 → 이 화면으로 돌아와 자동으로 받기
 *   로그인   → 서버가 공식계정 친구인지 확인
 *              친구 아님 → 친구추가 버튼 + 「追加したので受け取る」(다시 확인)
 *              친구      → 받음. 블프 기간 결제 때 자동 적용
 *
 * LINE 발송·띠 배너·인스타 링크는 전부 https://biteme.co.jp/bf 로 보낸다.
 * LINE 안에서 바로 로그인시키려면 /line-login?src=broadcast&next=/bf 도 된다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, Loader2, CheckCircle2 } from "lucide-react";
import { Footer } from "@/components/layout/Footer";
import biteMeLogo from "@/assets/bite-me-logo.png";
import { useAuthStore } from "@/stores/authStore";
import { initiateLineLogin } from "@/lib/line-auth";
import { BF_PERCENT, claimBfCoupon, isBfActive } from "@/lib/bfCoupon";
import { track } from "@/lib/track";

const LINE_FRIEND_URL = "https://line.me/R/ti/p/@621txosw";

type View = "idle" | "loading" | "ok" | "not_friend" | "ended" | "error";

export default function BfCoupon() {
  const navigate = useNavigate();
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const token = useAuthStore((s) => s.user?.lineSessionToken);
  const logout = useAuthStore((s) => s.logout);
  const [view, setView] = useState<View>("idle");
  const startedRef = useRef(false);

  const claim = useCallback(async (retry: boolean) => {
    if (!token) return;
    setView("loading");
    const r = await claimBfCoupon(token);
    track("bf_coupon_claim", { result: r.status, retry });
    if (r.status === "unauthorized") {
      logout();
      setView("idle");
      return;
    }
    setView(r.status === "ok" ? "ok" : r.status);
  }, [token, logout]);

  // 로그인 상태로 들어오면(로그인 후 복귀 포함) 바로 받기를 시도한다
  useEffect(() => {
    if (startedRef.current || !isLoggedIn || !token) return;
    startedRef.current = true;
    void claim(false);
  }, [isLoggedIn, token, claim]);

  const login = () => {
    track("bf_coupon_login_click");
    initiateLineLogin({ returnTo: "/bf", src: "button" }).catch(() => setView("error"));
  };

  const active = isBfActive();

  return (
    <div className="bg-background min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 bg-background border-b border-border">
        <div className="flex items-center gap-2 px-4 h-14">
          <button onClick={() => navigate(-1)} className="p-1 text-foreground" aria-label="戻る">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button onClick={() => navigate("/")} className="hover:opacity-80 transition-opacity">
            <img src={biteMeLogo} alt="BITE ME" className="h-[17px]" />
          </button>
        </div>
      </header>

      <main className="max-w-md mx-auto w-full px-5 py-10 flex-1 flex flex-col items-center text-center gap-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-widest text-red-600">BLACK FRIDAY 11/9〜11/22</p>
          <h1 className="text-2xl font-bold leading-snug">
            対象商品15%OFF に<br />LINE友だちは <span className="text-[#06C755]">さらに{BF_PERCENT}%OFF</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            BITE ME 公式LINEの友だち限定クーポン。受け取っておくと、セール期間中のお支払い時に自動で適用されます。
          </p>
        </div>

        <div className="w-full rounded-xl border border-border bg-card p-5 space-y-4">
          {!isLoggedIn && (
            <>
              <p className="text-sm">LINEでログインしてクーポンを受け取る</p>
              <LineButton onClick={login}>LINEでログインして受け取る</LineButton>
            </>
          )}

          {isLoggedIn && (view === "idle" || view === "loading") && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> 確認しています…
            </div>
          )}

          {isLoggedIn && view === "not_friend" && (
            <>
              <p className="text-sm font-semibold">友だち追加してから受け取る</p>
              <p className="text-xs text-muted-foreground">
                このクーポンは BITE ME 公式LINEの友だち限定です。友だち追加のあと、下のボタンをもう一度押してください。
              </p>
              <LineButton href={LINE_FRIEND_URL} onClick={() => track("bf_coupon_friend_click")}>友だち追加する</LineButton>
              <button
                onClick={() => void claim(true)}
                className="w-full h-11 rounded-lg border border-[#06C755] text-[#06C755] font-semibold text-sm"
              >
                追加したので受け取る
              </button>
            </>
          )}

          {isLoggedIn && view === "ok" && (
            <div className="space-y-2">
              <CheckCircle2 className="h-10 w-10 text-[#06C755] mx-auto" />
              <p className="font-semibold">クーポンを受け取りました</p>
              <p className="text-xs text-muted-foreground">
                {active
                  ? `お支払い時に${BF_PERCENT}%OFFが自動で適用されます。`
                  : `11/9(月) 10:00からのお支払い時に${BF_PERCENT}%OFFが自動で適用されます。`}
              </p>
              <button
                onClick={() => navigate("/")}
                className="mt-2 w-full h-11 rounded-lg bg-foreground text-background font-semibold text-sm"
              >
                お買い物を続ける
              </button>
            </div>
          )}

          {isLoggedIn && view === "ended" && (
            <p className="text-sm">このキャンペーンは終了しました。</p>
          )}

          {isLoggedIn && view === "error" && (
            <>
              <p className="text-sm">うまく確認できませんでした。もう一度お試しください。</p>
              <LineButton onClick={() => void claim(true)}>もう一度試す</LineButton>
            </>
          )}
        </div>

        <ul className="text-[11px] text-muted-foreground text-left space-y-1 w-full">
          <li>※SSFW商品は15%OFFの対象外です。</li>
          <li>※お一人さま1回限り。ご本人のアカウントでのみご利用いただけます。</li>
          <li>※初回クーポン(10%OFF)が未使用の方は、割引が大きい初回クーポンが優先して適用されます。</li>
          <li>※パートナー(アフィリエイト)の割引コードをお持ちの場合は、そちらが優先されます。</li>
          <li>※最終的な割引額はお支払い画面でご確認ください。</li>
        </ul>
      </main>

      <Footer />
    </div>
  );
}

function LineButton({ children, onClick, href }: { children: React.ReactNode; onClick?: () => void; href?: string }) {
  const cls = "w-full h-11 rounded-lg bg-[#06C755] text-white font-semibold text-sm flex items-center justify-center hover:opacity-90";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick} className={cls}>{children}</a>
  ) : (
    <button onClick={onClick} className={cls}>{children}</button>
  );
}
