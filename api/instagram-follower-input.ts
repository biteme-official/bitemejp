import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!process.env.ADMIN_SECRET || auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ message: 'UNAUTHORIZED' });
  }

  const { rows } = req.body as { rows?: { date: string; followers_count: number }[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ message: 'rows 배열이 필요합니다' });
  }

  const valid = rows.filter(
    (r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && typeof r.followers_count === 'number' && r.followers_count > 0
  );
  if (!valid.length) return res.status(400).json({ message: '유효한 행이 없습니다' });

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { error } = await supabase
    .from('instagram_follower_snapshots')
    .upsert(valid, { onConflict: 'date' });

  if (error) {
    console.error('[instagram-follower-input]', error);
    return res.status(500).json({ message: error.message });
  }

  return res.status(200).json({ ok: true, inserted: valid.length });
}
