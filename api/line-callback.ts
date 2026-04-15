import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac } from 'crypto';

const SHOPIFY_API_VERSION = '2025-07';

interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  email?: string;
}

interface ShopifySyncResult {
  customerAccessToken: string | null;
  shopifyEmail: string;
}

async function getStorefrontToken(): Promise<string> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error('Missing Shopify env vars');
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

  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

// Generate deterministic password from LINE userId so we can always login
function generatePassword(lineUserId: string): string {
  const secret = process.env.SHOPIFY_CLIENT_SECRET || 'fallback-secret';
  return createHmac('sha256', secret).update(lineUserId).digest('hex').substring(0, 32);
}

async function storefrontQuery(token: string, query: string, variables: Record<string, unknown> = {}) {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const res = await fetch(`https://${shop}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Shopify-Storefront-Private-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function syncLineUserToShopify(profile: LineProfile): Promise<ShopifySyncResult> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  if (!shop) return { customerAccessToken: null, shopifyEmail: '' };

  let token: string;
  try {
    token = await getStorefrontToken();
  } catch {
    return { customerAccessToken: null, shopifyEmail: '' };
  }

  const nameParts = profile.displayName.trim().split(' ');
  const firstName = nameParts[0] || profile.displayName;
  const lastName = nameParts.slice(1).join(' ') || firstName;
  const email = profile.email || `line_${profile.userId}@line-user.biteme.co.jp`;
  const password = generatePassword(profile.userId);

  // 1. Try to create customer
  const createResult = await storefrontQuery(token, `
    mutation customerCreate($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        customer { id email }
        customerUserErrors { code field message }
      }
    }
  `, { input: { email, password, firstName, lastName, acceptsMarketing: false } });

  const errors = createResult.data?.customerCreate?.customerUserErrors ?? [];
  const alreadyExists = errors.some((e: { code: string }) =>
    e.code === 'CUSTOMER_DISABLED' || e.code === 'EMAIL_TAKEN' || e.code === 'TAKEN'
  );

  if (alreadyExists) {
    console.log('[Shopify Sync] Customer already exists, attempting login');
  } else if (errors.length > 0) {
    console.error('[Shopify Sync] customerCreate errors:', JSON.stringify(errors));
  } else {
    console.log('[Shopify Sync] Customer created:', createResult.data?.customerCreate?.customer?.id);
  }

  // 2. Get customer access token
  const tokenResult = await storefrontQuery(token, `
    mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
      customerAccessTokenCreate(input: $input) {
        customerAccessToken { accessToken expiresAt }
        customerUserErrors { code message }
      }
    }
  `, { input: { email, password } });

  const accessToken = tokenResult.data?.customerAccessTokenCreate?.customerAccessToken?.accessToken || null;

  if (!accessToken) {
    console.warn('[Shopify Sync] Could not get customer access token');
  }

  return { customerAccessToken: accessToken, shopifyEmail: email };
}

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

const ALLOWED_REDIRECT_URIS = [
  'https://biteme.co.jp/auth/line/callback',
  'https://www.biteme.co.jp/auth/line/callback',
  'http://localhost:5173/auth/line/callback',
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

  const channelId = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelId || !channelSecret) {
    return res.status(500).json({ message: 'Server configuration error' });
  }

  const { code, redirectUri } = req.body;

  if (!code || !redirectUri) {
    return res.status(400).json({ message: 'Missing code or redirectUri' });
  }

  if (!ALLOWED_REDIRECT_URIS.includes(redirectUri)) {
    return res.status(400).json({ message: 'Invalid redirect URI' });
  }

  try {
    // 1. Exchange LINE auth code for tokens
    const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: channelId,
        client_secret: channelSecret,
      }),
    });

    if (!tokenResponse.ok) {
      return res.status(400).json({ message: 'Failed to exchange authorization code' });
    }

    const tokenData = await tokenResponse.json();

    // 2. Get LINE profile
    const profileResponse = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!profileResponse.ok) {
      return res.status(400).json({ message: 'Failed to get LINE profile' });
    }

    const profile = await profileResponse.json();

    // 3. Extract email from ID token
    let email: string | undefined;
    if (tokenData.id_token) {
      try {
        const verifyResponse = await fetch('https://api.line.me/oauth2/v2.1/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ id_token: tokenData.id_token, client_id: channelId }),
        });
        if (verifyResponse.ok) {
          email = (await verifyResponse.json()).email;
        }
      } catch { /* continue without email */ }
    }

    // 4. Sync to Shopify & get customer access token
    const shopifyResult = await syncLineUserToShopify({
      userId: profile.userId,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
      email,
    });

    // 5. Return profile + Shopify token
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    return res.status(200).json({
      userId: profile.userId,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
      email,
      shopifyCustomerToken: shopifyResult.customerAccessToken,
      shopifyEmail: shopifyResult.shopifyEmail,
    });
  } catch (error) {
    console.error('[LINE Callback] Error:', error);
    return res.status(500).json({ message: 'An error occurred. Please try again.' });
  }
}
