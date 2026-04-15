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
  });

  window.location.href = `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`;
}

export interface LineCallbackResult {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  email?: string;
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
