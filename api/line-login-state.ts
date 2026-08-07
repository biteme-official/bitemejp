/**
 * /api/line-login-state
 *
 * LINE 로그인 시작 전에 서버가 서명한 state 를 발급한다.
 *
 * 기존에는 클라이언트가 난수 state 를 만들어 localStorage 에 저장해두고
 * 콜백에서 비교했는데, LINE 앱을 거쳐 돌아오면 **다른 브라우저 컨텍스트**로
 * 열려 localStorage 가 비어 있어 "Invalid state parameter" 로 로그인이 실패했다.
 * (bot_prompt 로 친구추가 단계가 생기면서 이 핸드오프가 발생)
 *
 * 서명된 state 는 자체 검증이 가능하므로 브라우저가 바뀌어도 유효하다.
 * 돌아갈 경로(returnTo)도 함께 서명해 localStorage 의존을 제거한다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, randomBytes } from 'crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

/**
 * 오픈 리다이렉트 방지: 사이트 내부 절대경로만 허용한다.
 * `//evil.com` 같은 프로토콜 상대 URL 은 브라우저가 외부로 해석하므로 반드시 막는다.
 */
function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.length > 512) return '/';
  return value;
}

export function signState(returnTo: string, secret: string): string {
  const payload = {
    n: randomBytes(16).toString('hex'),
    e: Date.now() + STATE_TTL_MS,
    r: returnTo,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    console.error('[LINE State] 🔴 LINE_CHANNEL_SECRET 미설정');
    return res.status(500).json({ message: 'Server configuration error' });
  }

  const returnTo = sanitizeReturnTo(req.body?.returnTo);

  return res.status(200).json({ state: signState(returnTo, secret), returnTo });
}
