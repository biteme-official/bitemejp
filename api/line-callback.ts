import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';

const SHOPIFY_API_VERSION = '2025-07';

/**
 * api/line-login-state.ts 가 서명한 state 를 검증한다.
 *
 * localStorage 기반 검증은 LINE 앱을 거쳐 돌아올 때 브라우저 컨텍스트가 바뀌면
 * 값이 사라져 로그인이 통째로 실패했다. 서명은 자체 검증이 가능해 이 문제가 없다.
 *
 * 반환값: 검증 성공 시 돌아갈 경로, 실패 시 null.
 */
function verifySignedState(state: string, secret: string): { returnTo: string } | null {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;

  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.e !== 'number' || Date.now() > payload.e) return null;
    const r = typeof payload.r === 'string' ? payload.r : '/';
    // 오픈 리다이렉트 방지 — 서명되어 있어도 한 번 더 확인한다.
    const returnTo = r.startsWith('/') && !r.startsWith('//') ? r : '/';
    return { returnTo };
  } catch {
    return null;
  }
}

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
  /** 아직 실제 이메일이 없어 주문 확인 메일이 도달하지 못하는 상태 */
  needsEmail: boolean;
}

/**
 * LINE이 이메일을 주지 않은 유저에게 부여하는 자리표시자 도메인.
 * ⚠️ 이 도메인은 MX 레코드가 없어 실제로 메일이 도달하지 않는다.
 *    로그인 후 실제 이메일을 수집해 교체한다 (api/update-customer-email.ts).
 */
const PLACEHOLDER_EMAIL_DOMAIN = '@line-user.biteme.co.jp';

function placeholderEmail(lineUserId: string): string {
  return `line_${lineUserId}${PLACEHOLDER_EMAIL_DOMAIN}`;
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

/**
 * line_id 태그로 기존 고객을 찾는다.
 *
 * ⚠️ 이메일을 조회 키로 쓰면 안 된다. 유저가 실제 이메일을 등록하면 고객의 email이
 *    바뀌는데, 다음 로그인 때 다시 자리표시자 이메일로 조회하면 못 찾고
 *    중복 고객을 새로 만들어 버린다 (주문 이력 분리).
 *    LINE userId 는 불변이므로 이쪽을 키로 삼는다.
 */
async function findCustomerByLineId(
  adminToken: string,
  lineUserId: string
): Promise<{ id: string; email: string } | null> {
  const result = await adminGraphQL(adminToken, `
    query FindByLineId($query: String!) {
      customers(first: 1, query: $query) {
        edges { node { id email } }
      }
    }
  `, { query: `tag:"line_id:${lineUserId}"` });

  const node = result?.data?.customers?.edges?.[0]?.node;
  return node?.email ? { id: node.id, email: node.email } : null;
}

async function syncLineUserToShopify(profile: LineProfile): Promise<ShopifySyncResult> {
  const empty: ShopifySyncResult = {
    customerAccessToken: null,
    shopifyEmail: '',
    shopifyCustomerId: null,
    needsEmail: false,
  };

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  if (!shop) return empty;

  let token: string;
  try {
    token = await getStorefrontToken();
  } catch {
    return empty;
  }

  const nameParts = profile.displayName.trim().split(' ');
  const firstName = nameParts[0] || profile.displayName;
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
  const password = generatePassword(profile.userId);

  // Admin 토큰은 기존 고객 조회에도 쓰이므로 먼저 확보한다 (실패해도 로그인은 계속).
  let adminToken: string | null = null;
  try {
    adminToken = await getAdminToken();
  } catch (err) {
    console.error('[Shopify Sync] 🔴 Admin 토큰 발급 실패:', err);
  }

  // line_id 태그로 기존 고객을 먼저 찾는다. 찾으면 그 고객의 현재 이메일을 사용한다
  // (유저가 실제 이메일로 교체했을 수 있음). 못 찾으면 신규로 간주.
  let existing: { id: string; email: string } | null = null;
  if (adminToken) {
    try {
      existing = await findCustomerByLineId(adminToken, profile.userId);
    } catch (err) {
      console.error('[Shopify Sync] 🔴 line_id 조회 실패:', err);
    }
  }

  const email = existing?.email ?? profile.email ?? placeholderEmail(profile.userId);

  // 1. 기존 고객이 없을 때만 생성 시도
  if (!existing) {
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
    if (!adminToken) throw new Error('Admin 토큰 없음');

    // line_id 로 이미 찾았으면 재조회 불필요. 신규 고객만 email 로 GID 조회.
    let customerNode: { id: string } | null = existing ? { id: existing.id } : null;
    if (!customerNode) {
      const findResult = await adminGraphQL(adminToken, `
        query FindCustomer($query: String!) {
          customers(first: 1, query: $query) {
            edges { node { id } }
          }
        }
      `, { query: `email:"${email}"` });
      customerNode = findResult?.data?.customers?.edges?.[0]?.node ?? null;
    }

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

  return {
    customerAccessToken: accessToken,
    shopifyEmail: email,
    shopifyCustomerId,
    needsEmail: email.endsWith(PLACEHOLDER_EMAIL_DOMAIN),
  };
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

  const { code, redirectUri, state } = req.body;

  if (!code || !redirectUri) {
    return res.status(400).json({ message: 'Missing code or redirectUri' });
  }

  if (!ALLOWED_REDIRECT_URIS.includes(redirectUri)) {
    return res.status(400).json({ message: 'Invalid redirect URI' });
  }

  // 서명된 state 검증. 서명이 없는 state(구버전 클라이언트/서명 발급 실패 시 폴백)는
  // 클라이언트의 localStorage 대조로 보호되므로 통과시킨다.
  let returnTo = '/';
  if (typeof state === 'string' && state.includes('.')) {
    const verified = verifySignedState(state, channelSecret);
    if (!verified) {
      console.error('[LINE Callback] 🔴 state 서명 검증 실패 (위조 또는 만료)');
      return res.status(400).json({ message: 'ログインの有効期限が切れました。もう一度お試しください。' });
    }
    returnTo = verified.returnTo;
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
      needsEmail: shopifyResult.needsEmail,
      returnTo,
    });
  } catch (error) {
    console.error('[LINE Callback] Error:', error);
    return res.status(500).json({ message: 'An error occurred. Please try again.' });
  }
}
