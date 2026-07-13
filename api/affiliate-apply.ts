import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSign } from 'crypto';

const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const AFFILIATE_SHEET_ID = process.env.AFFILIATE_SHEET_ID || '';
// 시트 탭 이름(선택). 미지정 시 첫 번째 시트에 기록.
const AFFILIATE_SHEET_TAB = process.env.AFFILIATE_SHEET_TAB || '';

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

// 인스타그램 입력값 정규화: URL / @ 제거 후 핸들만 추출
function normalizeInstagram(raw: string): string {
  let v = raw.trim();
  v = v.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '');
  v = v.replace(/[/?#].*$/, ''); // 경로/쿼리 제거
  v = v.replace(/^@+/, '');
  return v.trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INSTAGRAM_RE = /^[A-Za-z0-9._]{1,30}$/;

// 서비스 계정 JWT → 액세스 토큰 (Sheets 쓰기 스코프)
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  })).toString('base64url');

  const input = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(input);
  const jwt = `${input}.${sign.sign(sa.private_key, 'base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) throw new Error(`Token error: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken!;
}

const tabPrefix = AFFILIATE_SHEET_TAB ? `${AFFILIATE_SHEET_TAB.replace(/'/g, "''")}!` : '';

// 이미 접수된 이메일인지 확인 (C열 = 메일)
async function isDuplicateEmail(token: string, email: string): Promise<boolean> {
  const range = encodeURIComponent(`${tabPrefix}C:C`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AFFILIATE_SHEET_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return false; // 조회 실패 시 중복검사는 건너뛰고 append 진행
  const data = await res.json();
  const rows: string[][] = data.values || [];
  return rows.some((r) => (r[0] || '').trim().toLowerCase() === email);
}

async function appendRow(token: string, row: (string | null)[]): Promise<void> {
  const range = encodeURIComponent(`${tabPrefix}A:F`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AFFILIATE_SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    }
  );
  if (!res.ok) throw new Error(`Sheets append error: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOrigin = getCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !AFFILIATE_SHEET_ID) {
    console.error('[affiliate-apply] Missing GOOGLE_SERVICE_ACCOUNT_JSON or AFFILIATE_SHEET_ID');
    return res.status(500).json({ error: 'Not configured' });
  }

  const { instagram: rawInstagram, email: rawEmail } = req.body ?? {};

  if (typeof rawInstagram !== 'string' || typeof rawEmail !== 'string') {
    return res.status(400).json({ error: 'instagram and email are required' });
  }

  const instagram = normalizeInstagram(rawInstagram);
  const email = rawEmail.trim().toLowerCase();

  if (!INSTAGRAM_RE.test(instagram)) return res.status(400).json({ error: 'invalid_instagram' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });

  try {
    const token = await getAccessToken();

    if (await isDuplicateEmail(token, email)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    // JST 접수일시 (YYYY-MM-DD HH:MM:SS)
    const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const userAgent = (req.headers['user-agent'] as string) ?? '';
    const referrer = (req.headers['referer'] as string) ?? '';

    // 컬럼: A=応募日時(JST) B=Instagram C=メール D=ステータス E=Referrer F=UserAgent
    await appendRow(token, [jst, instagram, email, 'pending', referrer, userAgent]);

    return res.status(200).json({ ok: true, duplicate: false });
  } catch (error) {
    console.error('[affiliate-apply]', error);
    return res.status(500).json({ error: 'Failed to submit' });
  }
}
