import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SHOPIFY_API_VERSION } from './_shopify-api-version.js';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

/**
 * Storefront 인증 토큰.
 *
 * 1순위: `SHOPIFY_STOREFRONT_TOKEN`(shpss_ 고정 토큰) — 발급 과정이 없어 인스턴스마다
 *   같은 값을 쓴다.
 * 2순위(폴백): OAuth client_credentials 로 매번 새 토큰 발급.
 *   ⚠️ 서버리스는 인스턴스마다 별도로 발급하는데, 여러 인스턴스가 동시에 뜨면
 *   (홈 첫 진입 = 요청 8~10개 동시) 발급 직후 토큰이 ACCESS_DENIED(403) 로 거절돼
 *   상품 목록이 통째로 비어 보였다(2026-09-18 장애). 순차 요청은 200 이라 curl 로는
 *   재현이 안 되고, 동시 요청 10개를 쏘면 재현된다.
 */
async function getAccessToken(): Promise<string> {
  const fixed = (process.env.SHOPIFY_STOREFRONT_TOKEN || '').trim();
  if (fixed) return fixed;

  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error(`Missing env vars: shop=${!!shop}, clientId=${!!clientId}, secret=${!!clientSecret}`);
  }

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
    throw new Error(`Token request failed (${response.status}): ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken!;
}

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

  try {
    const token = await getAccessToken();
    const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';

    const shopifyResponse = await fetch(
      `https://${shop}/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
    return res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
}
