import type { VercelRequest, VercelResponse } from '@vercel/node';

let cachedAdminToken: string | null = null;
let adminTokenExpiresAt: number = 0;
let cachedStorefrontToken: string | null = null;
let storefrontTokenExpiresAt: number = 0;

async function getAdminToken(): Promise<string> {
  const now = Date.now();
  if (cachedAdminToken && now < adminTokenExpiresAt - 5 * 60 * 1000) {
    return cachedAdminToken;
  }

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN!;
  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID!;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET!;

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Admin token failed (${response.status}): ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  if (!data.access_token) throw new Error('No admin access_token');
  cachedAdminToken = data.access_token;
  adminTokenExpiresAt = now + (data.expires_in ?? 86400) * 1000;
  return cachedAdminToken!;
}

async function getStorefrontToken(shop: string): Promise<string> {
  const now = Date.now();
  if (cachedStorefrontToken && now < storefrontTokenExpiresAt - 5 * 60 * 1000) {
    return cachedStorefrontToken;
  }

  const adminToken = await getAdminToken();

  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({
      query: `mutation {
        delegateAccessTokenCreate(input: {
          delegateAccessScope: [
            "unauthenticated_read_product_listings",
            "unauthenticated_read_product_inventory",
            "unauthenticated_write_checkouts",
            "unauthenticated_read_checkouts"
          ]
          expiresIn: 3600
        }) {
          delegateAccessToken { accessToken }
          userErrors { field message }
        }
      }`,
    }),
  });

  const data = await response.json();
  const errors = data?.data?.delegateAccessTokenCreate?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Delegate token error: ${JSON.stringify(errors)}`);
  }

  const token = data?.data?.delegateAccessTokenCreate?.delegateAccessToken?.accessToken;
  if (!token) {
    console.error('[Shopify] delegateAccessTokenCreate full response:', JSON.stringify(data).substring(0, 500));
    throw new Error('No delegate storefront token returned');
  }

  console.log('[Shopify] Storefront delegate token created');
  cachedStorefrontToken = token;
  storefrontTokenExpiresAt = now + 3600 * 1000;
  return token;
}

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)) return true;
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

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';

  try {
    const storefrontToken = await getStorefrontToken(shop);
    const apiVersion = '2025-10';

    const shopifyResponse = await fetch(
      `https://${shop}/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Shopify-Storefront-Private-Token': storefrontToken,
        },
        body: JSON.stringify(req.body),
      }
    );

    const data = await shopifyResponse.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    return res.status(shopifyResponse.status).send(data);
  } catch (error) {
    console.error('[Shopify Proxy] Error:', error);
    return res.status(500).json({ error: String(error) });
  }
}
