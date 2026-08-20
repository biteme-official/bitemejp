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

/**
 * 로그인 진입 경로(유입경로) 화이트리스트.
 *
 * 어느 입구가 연결을 만들었는지 고객 태그로 남기는데(`line_src:*`), 값을 그대로
 * 받으면 임의 문자열이 태그로 쌓인다. Shopify 고객 태그는 세그먼트 조건으로 쓰는
 * 자산이라 오염되면 되돌리기 어려우므로 여기서만 늘린다.
 */
export const LOGIN_SOURCES = [
  'welcome',    // LINE 웰컴(あいさつ) 메시지
  'richmenu',   // LINE 리치메뉴
  'broadcast',  // LINE 발송 메시지
  'banner',     // 사이트 상단 로그인 유도 배너
  'floating',   // 사이트 우하단 플로팅 버튼
  'button',     // 그 외 화면 내 로그인 버튼
  'other',
] as const;

export type LoginSource = (typeof LOGIN_SOURCES)[number];

export function sanitizeSource(value: unknown): LoginSource | null {
  return typeof value === 'string' && (LOGIN_SOURCES as readonly string[]).includes(value)
    ? (value as LoginSource)
    : null;
}

export function signState(returnTo: string, secret: string, src?: LoginSource | null): string {
  const payload = {
    n: randomBytes(16).toString('hex'),
    e: Date.now() + STATE_TTL_MS,
    r: returnTo,
    // ⚠️ src 를 localStorage 로 나르면 안 된다. LINE 앱을 거쳐 돌아올 때 브라우저
    //    컨텍스트가 바뀌어 값이 사라진다 (#106 과 같은 함정). 서명에 실어 보낸다.
    ...(src ? { s: src } : {}),
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
  const src = sanitizeSource(req.body?.src);

  return res.status(200).json({ state: signState(returnTo, secret, src), returnTo, src });
}
