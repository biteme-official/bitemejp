import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!token) return res.status(500).json({ error: 'No token' });

  const query = JSON.stringify({ query: '{ shop { name } }' });
  const candidates = [
    process.env.VITE_SHOPIFY_STORE_DOMAIN || '(not set)',
    'hihtsp-0m.myshopify.com',
    'biteme-jp.myshopify.com',
  ];
  const unique = [...new Set(candidates)];

  const results: Record<string, unknown> = {};
  for (const shop of unique) {
    try {
      const r = await fetch(`https://${shop}/api/2025-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Shopify-Storefront-Private-Token': token,
        },
        body: query,
      });
      const text = await r.text();
      results[shop] = { status: r.status, body: text.substring(0, 200) };
    } catch (e) {
      results[shop] = { error: String(e) };
    }
  }

  return res.status(200).json(results);
}
