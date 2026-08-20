import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { initiateLineLogin } from "@/lib/line-auth";
import { LINE_WELCOME_DISCOUNT_LABEL } from "@/lib/lineWelcomeDiscount";

/**
 * 비로그인 방문자에게 LINE 로그인을 안내하는 상단 띠 배너.
 *
 * 사이트에 로그인 진입점이 햄버거 메뉴·로그인 시트·/mypage 세 곳뿐이라,
 * 리치메뉴·광고·검색 어디로 들어와도 로그인이라는 선택지가 보이지 않았다 (#114).
 * 로그인해야 Shopify 고객과 LINE userId 가 연결되고, 그래야 주문·배송 알림과
 * 세그먼트 발송이 가능해진다.
 *
 * 쿠폰은 원래 "친구추가" 보상이었는데, 친구추가만으로는 고객과 LINE userId 가 연결되지
 * 않아 로그인 보상으로 옮겼다(#116). 로그인 성공 시 자동 적용되므로 문구가 사실이다.
 */
const COPY = {
  headline: `LINEでログインして${LINE_WELCOME_DISCOUNT_LABEL}`,
  body: "ご注文・配送のお知らせもLINEで届きます",
  cta: "ログイン",
  close: "閉じる",
};

/** 닫은 뒤 다시 보여주기까지의 기간. 매 방문마다 뜨면 피로해진다. */
const SNOOZE_DAYS = 7;
const SNOOZE_KEY = "login_banner_dismissed_at";

/**
 * 배너를 띄우지 않을 경로.
 * - /admin            내부용 대시보드
 * - /auth/line/callback  로그인 처리 중 화면
 * - /checkout         결제 흐름을 끊지 않는다
 * - /mypage           비로그인 시 이미 로그인 전용 화면이 뜬다
 */
const EXCLUDED = ["/admin", "/auth/line/callback", "/checkout", "/mypage"];

function isSnoozed(): boolean {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < SNOOZE_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function track(event: string) {
  try {
    window.gtag?.("event", event, { method: "line" });
  } catch {
    /* 계측 실패가 로그인 흐름을 막지 않는다 */
  }
}

export function LoginBanner() {
  const { pathname } = useLocation();
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const [dismissed, setDismissed] = useState(true);
  const [starting, setStarting] = useState(false);

  // localStorage 는 서버 렌더·초기 렌더에서 읽지 않는다.
  useEffect(() => {
    setDismissed(isSnoozed());
  }, []);

  const excluded = EXCLUDED.some((p) => pathname.startsWith(p));
  const visible = !isLoggedIn && !dismissed && !excluded;

  useEffect(() => {
    if (visible) track("login_banner_view");
  }, [visible]);

  if (!visible) return null;

  const handleLogin = () => {
    if (starting) return;
    setStarting(true);
    track("login_banner_click");
    // 로그인 후 복귀 경로는 initiateLineLogin 이 현재 URL 로 알아서 잡는다.
    initiateLineLogin({ src: 'banner' }).catch(() => setStarting(false));
  };

  const handleClose = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      /* 저장 실패해도 이번 렌더에서는 닫는다 */
    }
    setDismissed(true);
    track("login_banner_dismiss");
  };

  return (
    <div className="w-full bg-secondary border-b border-border">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3">
        <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-x-2 leading-snug">
          <span className="font-bold text-xs sm:text-sm text-foreground">{COPY.headline}</span>
          <span className="text-[11px] sm:text-sm text-muted-foreground">{COPY.body}</span>
        </div>

        <button
          onClick={handleLogin}
          disabled={starting}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs sm:text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          style={{ backgroundColor: "#06C755" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2C6.48 2 2 5.82 2 10.5c0 4.21 3.74 7.74 8.79 8.4.34.07.81.22.93.51.1.26.07.67.03.93l-.15.91c-.05.27-.22 1.07.94.58 1.16-.49 6.26-3.69 8.54-6.32C22.84 13.54 22 12.13 22 10.5 22 5.82 17.52 2 12 2Z"
              fill="white"
            />
          </svg>
          {COPY.cta}
        </button>

        <button
          onClick={handleClose}
          aria-label={COPY.close}
          className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
