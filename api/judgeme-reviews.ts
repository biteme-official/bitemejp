import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP_DOMAIN = 'hihtsp-0m.myshopify.com';
const PRIVATE_TOKEN = process.env.JUDGEME_PRIVATE_TOKEN || '';
const BASE_URL = 'https://judge.me/api/v1';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)
    ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 리뷰 목록 조회
  if (req.method === 'GET') {
    const { product_id, page = '1', per_page = '10' } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });

    const params = new URLSearchParams({
      api_token: PRIVATE_TOKEN,
      shop_domain: SHOP_DOMAIN,
      product_external_id: String(product_id),
      per_page: String(per_page),
      page: String(page),
    });

    const jRes = await fetch(`${BASE_URL}/reviews?${params}`);
    if (!jRes.ok) return res.status(jRes.status).json({ error: 'Failed to fetch reviews' });
    const data = await jRes.json();
    return res.status(200).json({
      reviews: data.reviews || [],
      current_page: data.current_page,
      per_page: data.per_page,
    });
  }

  // POST: 리뷰 작성
  if (req.method === 'POST') {
    const { product_id, name, email, rating, title, body } = req.body || {};
    if (!product_id || !name || !email || !rating) {
      return res.status(400).json({ error: 'product_id, name, email, rating are required' });
    }

    const jRes = await fetch(`${BASE_URL}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_token: PRIVATE_TOKEN,
        shop_domain: SHOP_DOMAIN,
        platform: 'shopify',
        id: Number(product_id),
        email,
        name,
        rating: Number(rating),
        title: title || '',
        body: body || '',
        review_date: new Date().toISOString(),
      }),
    });

    const data = await jRes.json();
    if (!jRes.ok) return res.status(jRes.status).json({ error: data.error || 'Failed to submit review' });
    return res.status(201).json({ review: data.review });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
