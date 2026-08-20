import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initiateLineLogin, type LoginSource } from '@/lib/line-auth';
import { useAuthStore } from '@/stores/authStore';
import { LINE_WELCOME_DISCOUNT_LABEL } from '@/lib/lineWelcomeDiscount';

/**
 * /line-login — LINE 안에서 곧바로 로그인을 시작하는 진입 경로.
 *
 * 리치메뉴·웰컴 메시지·발송 메시지의 CTA 에는 함수가 아니라 URL 을 넣어야 하는데,
 * 지금까지 로그인은 `initiateLineLogin()` 호출로만 시작할 수 있어서 몰 첫 화면으로
 * 보낸 뒤 유저가 로그인 버튼을 스스로 찾기를 기대할 수밖에 없었다. 그 한 단계가
 * 그대로 이탈이라 전용 경로를 둔다.
 *
 * LINE 인앱 브라우저에서는 비밀번호 입력 없이 인증되므로 사실상 한 번 탭으로 끝난다.
 *
 * 예) https://biteme.co.jp/line-login?src=welcome
 */

/** api/line-login-state.ts 의 LOGIN_SOURCES 와 같이 움직여야 한다 */
const ALLOWED_SOURCES: readonly LoginSource[] = [
  'welcome',
  'richmenu',
  'broadcast',
  'banner',
  'floating',
  'button',
  'other',
];

function parseSource(value: string | null): LoginSource {
  return ALLOWED_SOURCES.includes(value as LoginSource) ? (value as LoginSource) : 'other';
}

/** 오픈 리다이렉트 방지 — 사이트 내부 절대경로만 허용한다 (api/line-login-state.ts 와 동일 규칙) */
function parseNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.length > 512) return '/';
  return value;
}

export default function LineLoginEntry() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const [failed, setFailed] = useState(false);
  // StrictMode 의 이중 마운트로 로그인이 두 번 시작되지 않도록 한 번만 태운다.
  const startedRef = useRef(false);

  const src = parseSource(searchParams.get('src'));
  const next = parseNext(searchParams.get('next'));

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // 이미 로그인된 상태라면 다시 태울 이유가 없다. 바로 목적지로 보낸다.
    if (isLoggedIn) {
      navigate(next, { replace: true });
      return;
    }

    initiateLineLogin({ returnTo: next, src }).catch(() => setFailed(true));
  }, [isLoggedIn, navigate, next, src]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div
        className="w-12 h-12 rounded-full border-4 border-gray-200 animate-spin"
        style={{ borderTopColor: '#06C755' }}
        aria-hidden
      />
      <p className="text-sm text-gray-600">
        {failed ? 'ログインを開始できませんでした。' : 'LINEでログインしています…'}
      </p>

      {/* 자동 이동이 막히거나 실패했을 때를 위한 수동 진입점 */}
      <button
        onClick={() => {
          setFailed(false);
          initiateLineLogin({ returnTo: next, src }).catch(() => setFailed(true));
        }}
        className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-md text-white font-medium text-sm transition-colors hover:opacity-90"
        style={{ backgroundColor: '#06C755' }}
      >
        LINEでログインして{LINE_WELCOME_DISCOUNT_LABEL}
      </button>
    </div>
  );
}
