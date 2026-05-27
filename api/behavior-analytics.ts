import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.ADMIN_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const range = (req.query.range as string) || '7d';
  const days = range === 'today' ? 1 : range === '28d' ? 28 : range === '90d' ? 90 : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const [bannerRes, categoryRes, productRes, funnelRes] = await Promise.all([
    supabase.from('click_events').select('event_label').eq('event_type', 'banner_click').gte('created_at', since),
    supabase.from('click_events').select('event_label').eq('event_type', 'category_click').gte('created_at', since),
    supabase.from('click_events').select('event_label').eq('event_type', 'product_click').gte('created_at', since),
    Promise.all(
      ['product_click', 'add_to_cart', 'checkout_start'].map(type =>
        supabase.from('click_events').select('*', { count: 'exact', head: true }).eq('event_type', type).gte('created_at', since)
          .then(({ count }) => ({ event_type: type, count: count ?? 0 }))
      )
    ),
  ]);

  function aggregate(rows: { event_label: string | null }[] | null, limit = 10) {
    const map = new Map<string, number>();
    for (const row of rows ?? []) {
      const key = row.event_label || '(不明)';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  return res.status(200).json({
    bannerRanking: aggregate(bannerRes.data),
    categoryRanking: aggregate(categoryRes.data),
    productRanking: aggregate(productRes.data),
    funnel: funnelRes,
  });
}
