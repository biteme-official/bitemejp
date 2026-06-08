import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)) return true;
  if (/^https:\/\/bitemejp[a-z0-9-]*\.vercel\.app$/.test(origin)) return true;
  return false;
}

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  return isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOrigin = getCorsOrigin(req);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // In staging, forward server-side to production proxy to bypass Shopify IP restrictions
  const upstreamUrl = process.env.SHOPIFY_PROXY_UPSTREAM_URL;
  if (upstreamUrl) {
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await upstreamResponse.text();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      return res.status(upstreamResponse.status).send(data);
    } catch (error) {
      console.error('[Shopify Proxy] Upstream error:', error);
      return res.status(500).json({ error: String(error) });
    }
  }

  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';

  if (!token) {
    console.error('[Shopify Proxy] Missing SHOPIFY_STOREFRONT_TOKEN');
    return res.status(500).json({ error: 'Missing token configuration' });
  }

  try {
    const apiVersion = '2025-10';
    const shopifyResponse = await fetch(
      `https://${shop}/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Shopify-Storefront-Private-Token': token,
        },
        body: JSON.stringify(req.body),
      }
    );

    const data = await shopifyResponse.text();
    if (!shopifyResponse.ok) {
      console.error(`[Shopify] ${shopifyResponse.status}:`, data.substring(0, 200));
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    return res.status(shopifyResponse.status).send(data);
  } catch (error) {
    console.error('[Shopify Proxy] Error:', error);
    return res.status(500).json({ error: String(error) });
  }
}
