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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOrigin = getCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { event_type, session_id, properties, page_path, referrer } = req.body ?? {};
  if (!event_type || typeof event_type !== 'string') {
    return res.status(400).json({ error: 'event_type required' });
  }
  if (!session_id || typeof session_id !== 'string') {
    return res.status(400).json({ error: 'session_id required' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await supabase.from('events').insert({
    event_type,
    session_id,
    properties: typeof properties === 'object' && properties !== null ? properties : {},
    page_path: page_path ?? null,
    referrer: referrer ?? null,
  });

  if (error) {
    console.error('[track-event]', error);
    return res.status(500).json({ error: 'Failed to track' });
  }

  return res.status(200).json({ ok: true });
}
