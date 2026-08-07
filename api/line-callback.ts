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
  shopifyCustomerId: string | null;
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

async function getAdminToken(): Promise<string> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!shop || !clientId || !clientSecret) throw new Error('Missing Admin API env vars');

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Admin token failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function adminGraphQL(adminToken: string, query: string, variables: Record<string, unknown> = {}) {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': adminToken },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
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
  if (!shop) return { customerAccessToken: null, shopifyEmail: '', shopifyCustomerId: null };

  let token: string;
  try {
    token = await getStorefrontToken();
  } catch {
    return { customerAccessToken: null, shopifyEmail: '', shopifyCustomerId: null };
  }

  const nameParts = profile.displayName.trim().split(' ');
  const firstName = nameParts[0] || profile.displayName;
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
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

  // 기존 고객의 경우 비밀번호 불일치로 토큰 발급 실패 가능
  // Admin API는 password 필드를 지원하지 않으므로 재설정 불가
  // shopifyCustomerId를 통해 Admin API로 주문 조회는 별도 /api/customer-orders에서 처리
  if (!accessToken) {
    console.log('[Shopify Sync] No Storefront token (existing customer with different password). Orders will be fetched via Admin API.');
  }

  // 3. Admin API で顧客を検索して LINE userId をメタフィールドに保存
  let shopifyCustomerId: string | null = null;
  try {
    const adminToken = await getAdminToken();

    // email で顧客 GID を取得
    const findResult = await adminGraphQL(adminToken, `
      query FindCustomer($query: String!) {
        customers(first: 1, query: $query) {
          edges { node { id } }
        }
      }
    `, { query: `email:"${email}"` });

    const customerNode = findResult?.data?.customers?.edges?.[0]?.node;
    if (customerNode) {
      shopifyCustomerId = customerNode.id;

      // 기존 태그를 가져와서 line_id 태그 병합 (기존 태그 삭제 방지)
      const tagsResult = await adminGraphQL(adminToken, `
        query GetCustomerTags($id: ID!) {
          customer(id: $id) { tags }
        }
      `, { id: customerNode.id });

      const existingTags: string[] = tagsResult?.data?.customer?.tags ?? [];
      const lineTag = `line_id:${profile.userId}`;
      const mergedTags = Array.from(new Set([...existingTags.filter((t: string) => !t.startsWith('line_id:')), lineTag]));

      const updateResult = await adminGraphQL(adminToken, `
        mutation SaveLineId($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }
      `, {
        input: {
          id: customerNode.id,
          tags: mergedTags,
          metafields: [{
            namespace: 'custom',
            key: 'line_id',
            value: profile.userId,
            type: 'single_line_text_field',
          }],
        },
      });

      // ⚠️ 이 매핑이 LINE CRM(세그먼트 발송)의 유일한 연결고리다.
      // 실패해도 로그인 자체는 성공시키되, 절대 조용히 넘기지 않는다.
      // 2026-08-07: REPORT 앱에 write_customers 스코프가 없어 전량 실패하고 있던 것을
      //             console.warn 이 삼켜서 1년 가까이 발견되지 않았음 (Issue #102).
      const userErrors = updateResult?.data?.customerUpdate?.userErrors ?? [];
      const topErrors = updateResult?.errors;
      if (topErrors) {
        console.error(
          '[Shopify Sync] 🔴 LINE ID 매핑 저장 실패 (GraphQL). write_customers 스코프를 확인하세요:',
          JSON.stringify(topErrors)
        );
      } else if (userErrors.length > 0) {
        console.error('[Shopify Sync] 🔴 LINE ID 매핑 저장 실패 (userErrors):', JSON.stringify(userErrors));
      } else if (!updateResult?.data?.customerUpdate?.customer?.id) {
        console.error('[Shopify Sync] 🔴 LINE ID 매핑 저장 실패 (응답에 customer 없음):', JSON.stringify(updateResult));
      } else {
        console.log('[Shopify Sync] LINE ID tag+metafield saved for', customerNode.id);
      }
    } else {
      console.error('[Shopify Sync] 🔴 LINE ID 매핑 대상 고객을 찾지 못함:', email);
    }
  } catch (err) {
    console.error('[Shopify Sync] 🔴 LINE ID 매핑 저장 중 예외:', err);
  }

  return { customerAccessToken: accessToken, shopifyEmail: email, shopifyCustomerId };
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
      shopifyCustomerId: shopifyResult.shopifyCustomerId,
    });
  } catch (error) {
    console.error('[LINE Callback] Error:', error);
    return res.status(500).json({ message: 'An error occurred. Please try again.' });
  }
}
