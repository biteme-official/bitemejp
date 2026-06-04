import type { Connect } from 'vite';

const SHOPIFY_API_VERSION = '2025-07';

interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  email?: string;
}

async function getStorefrontToken(): Promise<string> {
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

  const data = await response.json() as { access_token: string };
  return data.access_token;
}

async function syncLineUserToShopify(profile: LineProfile): Promise<void> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  if (!shop) {
    console.warn('[Shopify Sync] Missing VITE_SHOPIFY_STORE_DOMAIN — skipping');
    return;
  }

  let token: string;
  try {
    token = await getStorefrontToken();
  } catch (e) {
    console.warn('[Shopify Sync] Failed to get token — skipping:', e);
    return;
  }

  const nameParts = profile.displayName.trim().split(' ');
  const firstName = nameParts[0] || profile.displayName;
  const lastName = nameParts.slice(1).join(' ') || firstName;
  const email = profile.email || `line_${profile.userId}@line-user.biteme.co.jp`;

  // Generate a random password for the Shopify account
  const password = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const mutation = `
    mutation customerCreate($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        customer { id email }
        customerUserErrors { code field message }
      }
    }
  `;

  const res = await fetch(`https://${shop}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Shopify-Storefront-Private-Token': token,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: { email, password, firstName, lastName, acceptsMarketing: false },
      },
    }),
  });

  const data = await res.json() as {
    data?: { customerCreate?: { customer?: { id: string }; customerUserErrors?: Array<{ code: string; message: string }> } };
  };

  const errors = data.data?.customerCreate?.customerUserErrors ?? [];
  const alreadyExists = errors.some(e => e.code === 'CUSTOMER_DISABLED' || e.code === 'EMAIL_TAKEN');

  if (alreadyExists) {
    console.log('[Shopify Sync] Customer already exists for LINE user:', profile.userId);
  } else if (errors.length > 0) {
    console.error('[Shopify Sync] customerCreate errors:', JSON.stringify(errors));
  } else {
    console.log('[Shopify Sync] Customer created:', data.data?.customerCreate?.customer?.id);
  }
}

const ALLOWED_REDIRECT_URIS = [
  'https://biteme.co.jp/auth/line/callback',
  'https://www.biteme.co.jp/auth/line/callback',
  'http://localhost:5173/auth/line/callback',
];

export function lineCallbackMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (req.url !== '/api/line-callback' || req.method !== 'POST') {
      return next();
    }

    const channelId = process.env.LINE_CHANNEL_ID || process.env.VITE_LINE_CHANNEL_ID;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    if (!channelId || !channelSecret) {
      console.error('[LINE Callback] Missing LINE_CHANNEL_ID or LINE_CHANNEL_SECRET');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Server configuration error' }));
      return;
    }

    try {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const { code, redirectUri } = body;

      if (!code || !redirectUri) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Missing code or redirectUri' }));
        return;
      }

      // Validate redirectUri against whitelist
      if (!ALLOWED_REDIRECT_URIS.includes(redirectUri)) {
        console.error('[LINE Callback] Invalid redirectUri:', redirectUri);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Invalid redirect URI' }));
        return;
      }

      // 1. Exchange authorization code for tokens
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
        const errorText = await tokenResponse.text();
        console.error('[LINE Callback] Token exchange failed:', errorText);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Failed to exchange authorization code' }));
        return;
      }

      const tokenData = await tokenResponse.json();
      const accessToken = tokenData.access_token;
      const idToken = tokenData.id_token;

      // 2. Get user profile
      const profileResponse = await fetch('https://api.line.me/v2/profile', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!profileResponse.ok) {
        const errorText = await profileResponse.text();
        console.error('[LINE Callback] Profile fetch failed:', errorText);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Failed to get LINE profile' }));
        return;
      }

      const profile = await profileResponse.json();

      // 3. Try to extract email from ID token
      let email: string | undefined;
      if (idToken) {
        try {
          const verifyResponse = await fetch('https://api.line.me/oauth2/v2.1/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              id_token: idToken,
              client_id: channelId,
            }),
          });

          if (verifyResponse.ok) {
            const idTokenData = await verifyResponse.json();
            email = idTokenData.email;
          }
        } catch (e) {
          console.error('[LINE Callback] ID token verification failed:', e);
        }
      }

      // 4. Sync customer to Shopify Admin
      await syncLineUserToShopify({
        userId: profile.userId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
        email,
      });

      // 5. Return user profile
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        userId: profile.userId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
        email,
      }));
    } catch (error) {
      console.error('[LINE Callback] Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Internal server error' }));
    }
  };
}
