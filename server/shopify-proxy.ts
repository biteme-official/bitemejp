import type { Connect } from 'vite';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // Refresh token 5 minutes before expiry
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';

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
    throw new Error(`Failed to get access token: ${response.status} ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;

  console.log('[Shopify Proxy] Access token refreshed, expires in', data.expires_in, 'seconds');
  return cachedToken!;
}

export function shopifyProxyMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (req.url !== '/api/shopify' || req.method !== 'POST') {
      return next();
    }

    try {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString('utf-8');

      // Get access token
      const token = await getAccessToken();

      const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
      const apiVersion = '2025-07';

      // Forward to Shopify Storefront API
      const shopifyResponse = await fetch(
        `https://${shop}/api/${apiVersion}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Shopify-Storefront-Private-Token': token,
          },
          body,
        }
      );

      const responseData = await shopifyResponse.text();

      res.writeHead(shopifyResponse.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(responseData);
    } catch (error) {
      console.error('[Shopify Proxy] Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: (error as Error).message }));
    }
  };
}
