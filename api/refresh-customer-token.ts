/**
 * /api/refresh-customer-token
 *
 * LINE userId を受け取り、Shopify の customerAccessToken を再発行して返す。
 * 体크아웃 직전에 호출하여 항상 유효한 토큰을 사용하도록 보장한다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac } from 'crypto';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
const SHOPIFY_API_VERSION = '2025-10';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

function generatePassword(lineUserId: string): string {
  const secret = process.env.SHOPIFY_CLIENT_SECRET || 'fallback-secret';
  return createHmac('sha256', secret).update(lineUserId).digest('hex').substring(0, 32);
}

async function getStorefrontToken(): Promise<string> {
  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing Shopify env vars');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function storefrontMutation(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Shopify-Storefront-Private-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)
    ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lineUserId, shopifyEmail } = req.body || {};
  if (!lineUserId || !shopifyEmail) {
    return res.status(400).json({ error: 'lineUserId and shopifyEmail are required' });
  }

  try {
    const sfToken = await getStorefrontToken();
    const password = generatePassword(lineUserId);

    const result = await storefrontMutation(sfToken, `
      mutation RefreshToken($input: CustomerAccessTokenCreateInput!) {
        customerAccessTokenCreate(input: $input) {
          customerAccessToken {
            accessToken
            expiresAt
          }
          customerUserErrors { code message }
        }
      }
    `, { input: { email: shopifyEmail, password } });

    const accessToken = result?.data?.customerAccessTokenCreate?.customerAccessToken?.accessToken;
    const errors = result?.data?.customerAccessTokenCreate?.customerUserErrors || [];

    if (!accessToken) {
      console.error('[Refresh Token] Failed:', errors);
      return res.status(401).json({ error: 'Could not refresh token', details: errors });
    }

    return res.status(200).json({ customerAccessToken: accessToken });
  } catch (error) {
    console.error('[Refresh Token]', error);
    return res.status(500).json({ error: 'Internal error', message: error instanceof Error ? error.message : 'Unknown' });
  }
}
