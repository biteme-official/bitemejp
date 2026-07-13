import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOrigin = getCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { instagram: rawInstagram, email: rawEmail } = req.body ?? {};

  if (typeof rawInstagram !== 'string' || typeof rawEmail !== 'string') {
    return res.status(400).json({ error: 'instagram and email are required' });
  }

  const instagram = normalizeInstagram(rawInstagram);
  const email = rawEmail.trim().toLowerCase();

  if (!INSTAGRAM_RE.test(instagram)) {
    return res.status(400).json({ error: 'invalid_instagram' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await supabase.from('affiliate_applications').insert({
    instagram,
    email,
    user_agent: (req.headers['user-agent'] as string) ?? null,
    referrer: (req.headers['referer'] as string) ?? null,
  });

  if (error) {
    // 23505 = unique_violation (동일 이메일 재신청)
    if (error.code === '23505') {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    console.error('[affiliate-apply]', error);
    return res.status(500).json({ error: 'Failed to submit' });
  }

  return res.status(200).json({ ok: true, duplicate: false });
}
