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

export function initiateLineLogin(): void {
  const state = generateRandomState();
  localStorage.setItem('line_login_state', state);
  // Save the current page so we can return after login
  localStorage.setItem('line_login_return_to', window.location.pathname + window.location.search);

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
}

export async function handleLineCallback(code: string, state: string): Promise<LineCallbackResult> {
  const savedState = localStorage.getItem('line_login_state');
  if (!savedState || savedState !== state) {
    throw new Error('Invalid state parameter. Please try logging in again.');
  }
  localStorage.removeItem('line_login_state');

  const callbackUrl = getCallbackUrl();
  const response = await fetch('/api/line-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri: callbackUrl }),
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
