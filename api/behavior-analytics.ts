import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

  const { data: events, error } = await supabase
    .from('events')
    .select('event_type, session_id, properties, page_path')
    .gte('created_at', since);

  if (error) {
    console.error('[behavior-analytics]', error);
    return res.status(500).json({ error: 'Query failed' });
  }

  // Session-level funnel — counts unique sessions that reached each step
  const sessions = {
    page_view_home: new Set<string>(),
    product_click:  new Set<string>(),
    product_view:   new Set<string>(),
    add_to_cart:    new Set<string>(),
    checkout_start: new Set<string>(),
    order_complete: new Set<string>(),
  };

  const bannerMap   = new Map<string, number>();
  const categoryMap = new Map<string, number>();
  const productMap  = new Map<string, number>();

  for (const e of events ?? []) {
    const { event_type, session_id, properties, page_path } = e;
    const props = (properties ?? {}) as Record<string, unknown>;

    if (event_type === 'page_view' && page_path === '/') sessions.page_view_home.add(session_id);
    if (event_type === 'product_click')  sessions.product_click.add(session_id);
    if (event_type === 'product_view')   sessions.product_view.add(session_id);
    if (event_type === 'add_to_cart')    sessions.add_to_cart.add(session_id);
    if (event_type === 'checkout_start') sessions.checkout_start.add(session_id);
    if (event_type === 'order_complete') sessions.order_complete.add(session_id);

    if (event_type === 'banner_click') {
      const key = String(props.banner_title ?? '(不明)');
      bannerMap.set(key, (bannerMap.get(key) ?? 0) + 1);
    }
    if (event_type === 'category_click') {
      const key = String(props.name ?? props.handle ?? '(不明)');
      categoryMap.set(key, (categoryMap.get(key) ?? 0) + 1);
    }
    if (event_type === 'product_click' || event_type === 'product_view') {
      const key = String(props.product_title ?? '(不明)');
      productMap.set(key, (productMap.get(key) ?? 0) + 1);
    }
  }

  const toRanking = (map: Map<string, number>, limit = 10) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, count]) => ({ label, count }));

  return res.status(200).json({
    funnel: [
      { step: 'page_view_home', label: '메인 진입',  count: sessions.page_view_home.size },
      { step: 'product_click',  label: '상품 클릭',  count: sessions.product_click.size },
      { step: 'product_view',   label: '상품 상세',  count: sessions.product_view.size },
      { step: 'add_to_cart',    label: '장바구니',   count: sessions.add_to_cart.size },
      { step: 'checkout_start', label: '결제 시작',  count: sessions.checkout_start.size },
      { step: 'order_complete', label: '주문 완료',  count: sessions.order_complete.size },
    ],
    bannerRanking:   toRanking(bannerMap),
    categoryRanking: toRanking(categoryMap),
    productRanking:  toRanking(productMap),
  });
}
