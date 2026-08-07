const LINE_CHANNEL_ID = import.meta.env.VITE_LINE_CHANNEL_ID || '2009515277';

function getCallbackUrl(): string {
  const origin = window.location.origin;
  return `${origin}/auth/line/callback`;
}

function generateRandomState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 서버가 서명한 state 를 발급받는다.
 *
 * ⚠️ localStorage 만으로 state 를 검증하면 안 된다. LINE 앱을 거쳐 돌아올 때
 *    다른 브라우저 컨텍스트로 열려 값이 사라지고 로그인이 통째로 실패한다
 *    ("Invalid state parameter"). 서명된 state 는 브라우저가 바뀌어도 유효하다.
 *
 * 발급에 실패하면 기존 난수 state 로 폴백한다. 이 경우 서버는 서명 검증을
 * 건너뛰고 아래 localStorage 대조가 CSRF 방어를 담당한다.
 */
async function issueState(returnTo: string): Promise<string> {
  try {
    const res = await fetch('/api/line-login-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnTo }),
    });
    if (!res.ok) throw new Error(`state 발급 실패: ${res.status}`);
    const data = await res.json();
    if (typeof data?.state !== 'string' || !data.state) throw new Error('state 응답 형식 오류');
    return data.state;
  } catch (err) {
    console.error('[LINE Login] 서명 state 발급 실패, 난수로 폴백:', err);
    return generateRandomState();
  }
}

export async function initiateLineLogin(): Promise<void> {
  const returnTo = window.location.pathname + window.location.search;
  const state = await issueState(returnTo);

  localStorage.setItem('line_login_state', state);
  // Save the current page so we can return after login
  localStorage.setItem('line_login_return_to', returnTo);

  const callbackUrl = getCallbackUrl();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: LINE_CHANNEL_ID,
    redirect_uri: callbackUrl,
    state: state,
    scope: 'profile openid email',
    // 로그인 흐름에 공식계정(@621txosw) 친구추가 단계를 삽입.
    // LINE 푸시 메시지는 친구에게만 발송 가능하므로 CRM의 전제 조건.
    // ⚠️ LINE Developers > Login 채널 > "링크된 LINE 공식계정" 설정이
    //    비어 있으면 이 파라미터는 조용히 무시된다.
    bot_prompt: 'aggressive',
  });

  window.location.href = `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`;
}

export interface LineCallbackResult {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  email?: string;
  shopifyCustomerToken?: string;
  shopifyEmail?: string;
  shopifyCustomerId?: string;
  /** true 이면 자리표시자 이메일 상태 — 주문 확인 메일이 도달하지 않는다 */
  needsEmail?: boolean;
  /** 서명된 state 에서 복원한 복귀 경로. localStorage 가 없을 때 사용한다. */
  returnTo?: string;
}

/** 서명된 state 는 `<base64url payload>.<base64url 서명>` 형식이다 */
function isSignedState(state: string): boolean {
  const dot = state.indexOf('.');
  return dot > 0 && dot < state.length - 1;
}

export async function handleLineCallback(code: string, state: string): Promise<LineCallbackResult> {
  const savedState = localStorage.getItem('line_login_state');

  if (savedState) {
    // 같은 브라우저로 돌아온 경우 — 기존대로 엄격히 대조한다.
    if (savedState !== state) {
      throw new Error('Invalid state parameter. Please try logging in again.');
    }
  } else if (!isSignedState(state)) {
    // localStorage 도 없고 서명도 없으면 검증 수단이 전혀 없다 → 거부.
    throw new Error('Invalid state parameter. Please try logging in again.');
  }
  // localStorage 가 없고 서명이 있는 경우(= LINE 앱 경유로 브라우저가 바뀐 정상 흐름)는
  // 서버가 서명을 검증한다.

  localStorage.removeItem('line_login_state');

  const callbackUrl = getCallbackUrl();
  const response = await fetch('/api/line-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri: callbackUrl, state }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || 'LINE login failed');
  }

  return response.json();
}

export interface SubmitEmailResult {
  email: string;
  /** 이메일 변경으로 재발급된 토큰. null 이면 기존 토큰을 유지한다. */
  customerAccessToken?: string | null;
}

/**
 * LINE이 이메일을 주지 않은 유저의 실제 이메일을 등록한다.
 * 자리표시자 이메일(@line-user.biteme.co.jp)은 메일이 도달하지 않아
 * 주문 확인·배송 알림을 받지 못하므로 로그인 직후 수집한다.
 */
export async function submitCustomerEmail(
  customerAccessToken: string,
  email: string
): Promise<SubmitEmailResult> {
  const response = await fetch('/api/update-customer-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerAccessToken, email }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || 'メールアドレスの登録に失敗しました。');
  }

  return data;
}
