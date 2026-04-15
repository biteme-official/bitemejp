import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOPIFY_API_VERSION = '2025-07';
const METAFIELD_NAMESPACE = 'custom';
const METAFIELD_KEY = 'wishlist';

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

async function adminQuery(query: string, variables: Record<string, unknown>) {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN;

  if (!shop || !token) throw new Error('Missing SHOPIFY_ADMIN_API_TOKEN or VITE_SHOPIFY_STORE_DOMAIN');

  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Admin API error: ${res.status}`);
  return res.json();
}

async function findCustomer(lineUserId: string) {
  const email = `line_${lineUserId}@line-user.biteme.co.jp`;
  const data = await adminQuery(
    `query getCustomer($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
              id
              value
            }
          }
        }
      }
    }`,
    { query: `email:${email}` }
  );
  return data.data?.customers?.edges?.[0]?.node ?? null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOrigin = getCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const lineUserId = req.method === 'GET'
    ? (req.query.lineUserId as string)
    : req.body?.lineUserId;

  if (!lineUserId) return res.status(400).json({ error: 'lineUserId required' });

  try {
    if (req.method === 'GET') {
      const customer = await findCustomer(lineUserId);
      if (!customer) return res.status(200).json({ items: [] });

      const value = customer.metafield?.value;
      const items = value ? JSON.parse(value) : [];
      return res.status(200).json({ items });
    }

    if (req.method === 'POST') {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

      const customer = await findCustomer(lineUserId);
      if (!customer) return res.status(404).json({ error: 'Customer not found' });

      await adminQuery(
        `mutation setWishlist($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }`,
        {
          metafields: [{
            ownerId: customer.id,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            value: JSON.stringify(items),
            type: 'json',
          }],
        }
      );

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Wishlist API] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
