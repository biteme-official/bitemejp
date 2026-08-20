import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';
import { sanitizeSource, type LoginSource } from './line-login-state';

const SHOPIFY_API_VERSION = '2025-07';

/** 유입경로 태그 접두사 — `line_src:welcome` 형태로 붙는다 */
const SOURCE_TAG_PREFIX = 'line_src:';

/**
 * api/line-login-state.ts 가 서명한 state 를 검증한다.
 *
 * localStorage 기반 검증은 LINE 앱을 거쳐 돌아올 때 브라우저 컨텍스트가 바뀌면
 * 값이 사라져 로그인이 통째로 실패했다. 서명은 자체 검증이 가능해 이 문제가 없다.
 *
 * 반환값: 검증 성공 시 돌아갈 경로, 실패 시 null.
 */
function verifySignedState(
  state: string,
  secret: string
): { returnTo: string; src: LoginSource | null } | null {
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
    return { returnTo, src: sanitizeSource(payload.s) };
  } catch {
    return null;
  }
}

/** 로그인 세션 토큰 유효기간. 만료되면 LINE 재로그인 1회로 갱신된다. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 로그인 세션 토큰을 발급한다.
 *
 * LINE OAuth 코드 교환에 성공한 요청에만 발급되므로 "이 사람이 이 LINE 계정의
 * 주인이다"는 증명이 된다. 주문 조회·이메일 등록 API 는 이 서명을 확인하고
 * **클라이언트가 보낸 고객 ID 는 신뢰하지 않는다.**
 *
 * 서명 형식은 api/line-login-state.ts 의 state 와 동일하다
 * (`<base64url 페이로드>.<base64url 서명>`, 비밀키도 LINE_CHANNEL_SECRET 재사용).
 */
function signSessionToken(
  lineUserId: string,
  shopifyCustomerId: string | null,
  secret: string
): string {
  const payload = {
    u: lineUserId,
    c: shopifyCustomerId,
    e: Date.now() + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
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

/**
 * 이메일로 고객 GID 를 찾는다 (폴백 전용).
 *
 * ⚠️ Shopify 고객 검색 인덱스는 생성 직후 즉시 반영되지 않는다.
 *    2026-08-10 프로덕션 실측: 생성 +1.2s·+2.5s·+4.9s 모두 NOT FOUND, +9.3s 에 최초 반영.
 *    그래서 신규 고객은 customerCreate 가 돌려준 ID 를 그대로 쓰고, 이 경로는
 *    그 ID 를 얻지 못했을 때(이미 존재하던 고객 등)만 탄다 — 그 경우 인덱스에는
 *    이미 들어있으므로 보통 첫 시도에 찾는다. 재시도는 안전망이다.
 */
async function findCustomerIdByEmail(
  adminToken: string,
  email: string,
  attempts = 3
): Promise<{ id: string } | null> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1500 * i));

    const findResult = await adminGraphQL(adminToken, `
      query FindCustomer($query: String!) {
        customers(first: 1, query: $query) {
          edges { node { id } }
        }
      }
    `, { query: `email:"${email}"` });

    const node = findResult?.data?.customers?.edges?.[0]?.node ?? null;
    if (node) return node;
  }
  return null;
}

async function syncLineUserToShopify(
  profile: LineProfile,
  loginSource: LoginSource | null
): Promise<ShopifySyncResult> {
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

  // ⚠️ 이 스토어는 성(姓)을 필수로 요구한다. LINE 표시이름에 공백이 없으면 lastName 이
  //    비게 되고, customerCreate 가 `BLANK: Last nameを入力してください` 로 실패해
  //    고객·토큰·CRM 연계가 통째로 누락된다 (로그인은 성공한 것처럼 보인다).
  //    2026-04-28 커밋 b0f0dc2 가 `|| firstName` 폴백을 지우면서 생긴 회귀 — 그 이후
  //    가입 성공자 65명은 전원 공백이 있는 이름이었다(공백 없는 이름 0명, #108).
  //    전각 공백(U+3000)도 구분자로 인정한다 — 일본어 이름에서 흔하다.
  const displayName = profile.displayName?.trim() || 'LINEユーザー';
  const nameParts = displayName.split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || firstName;
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
  //    생성 성공 시 반환된 ID 를 보관한다 — 검색 인덱스 지연 때문에 이 ID 가 없으면
  //    바로 뒤의 매핑 저장이 대상 고객을 못 찾고 통째로 스킵된다 (#108).
  let createdCustomerId: string | null = null;
  // 이메일 검색 폴백은 "고객이 이미 존재한다"고 확인됐을 때만 의미가 있다.
  // 생성이 실패한 유저를 검색하면 없는 고객을 찾느라 재시도 대기만 쓰고
  // 그만큼 로그인 응답이 늦어진다.
  let customerMayExist = false;
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
    // customerUserErrors 만 보면 스로틀링·토큰 오류 같은 최상위 GraphQL 실패가
    // "오류 0건"으로 보여 생성 성공으로 오인된다. 고객 ID 유무까지 함께 확인한다.
    const createdCustomer = createResult.data?.customerCreate?.customer ?? null;
    const topLevelErrors = createResult.errors;

    if (alreadyExists) {
      customerMayExist = true;
      console.log('[Shopify Sync] Customer already exists, attempting login');
    } else if (errors.length > 0 || topLevelErrors || !createdCustomer?.id) {
      // 생성 실패는 곧 이 유저 전체 누락(고객·토큰·이메일 수집·CRM 연계)이다.
      // 응답은 200 이라 화면상 로그인은 성공해 보이므로 로그로만 드러난다.
      console.error(
        '[Shopify Sync] 🔴 신규 고객 생성 실패 — 이 유저는 Shopify 고객/토큰/CRM 연계가 모두 누락됩니다:',
        JSON.stringify(topLevelErrors ?? (errors.length > 0 ? errors : createResult))
      );
    } else {
      createdCustomerId = createdCustomer.id;
      console.log('[Shopify Sync] Customer created:', createdCustomerId);
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

    // 고객 GID 확보 순서: line_id 조회 결과 → 방금 생성한 고객 ID → 이메일 검색(폴백).
    // 방금 만든 고객을 검색으로 찾으려 하면 인덱스 지연 때문에 항상 실패한다 (#108).
    // Storefront customerCreate 가 주는 ID 는 Admin GID 와 동일 형식이라 그대로 쓸 수 있다.
    let customerNode: { id: string } | null =
      existing ? { id: existing.id } : createdCustomerId ? { id: createdCustomerId } : null;
    if (!customerNode && customerMayExist) {
      customerNode = await findCustomerIdByEmail(adminToken, email);
    }

    if (customerNode) {
      shopifyCustomerId = customerNode.id;

      // 기존 태그를 가져와서 line_id 태그 병합 (기존 태그 삭제 방지)
      const tagsResult = await adminGraphQL(adminToken, `
        query GetCustomerTags($id: ID!) {
          customer(id: $id) { tags }
        }
      `, { id: customerNode.id });

      // ⚠️ customerUpdate 의 tags 는 병합이 아니라 전체 교체다. 그래서 기존 태그를
      //    먼저 읽어 합치는데, 이 조회가 실패했을 때 []로 넘어가면 그 고객의 태그가
      //    (joy_tag_member 등 포함) 통째로 지워진다. 조회 실패 시엔 태그를 아예 건드리지
      //    않고 메타필드만 저장한다 — 태그는 다음 로그인에서 다시 시도된다.
      const existingTags: string[] | undefined = tagsResult?.data?.customer?.tags;
      const lineTag = `line_id:${profile.userId}`;
      // line_id 태그는 사람마다 값이 달라 Shopify 고객 세그먼트로 묶을 수 없다.
      // "LINE 로그인 회원 전체"를 하나의 조건으로 잡기 위한 공통 태그를 함께 붙인다
      // (회원 전용 쿠폰·세그먼트 발송의 기준).
      const memberTag = 'line_member';

      const updateInput: Record<string, unknown> = {
        id: customerNode.id,
        metafields: [{
          namespace: 'custom',
          key: 'line_id',
          value: profile.userId,
          type: 'single_line_text_field',
        }],
      };

      if (Array.isArray(existingTags)) {
        // 유입경로 태그는 **처음 연결될 때만** 남긴다(first-touch). 재로그인마다 덮어쓰면
        // "무엇이 이 고객을 데려왔나"가 마지막 클릭으로 바뀌어, 웰컴 메시지·리치메뉴가
        // 만든 연결의 기여가 통째로 사라진다.
        const alreadyTagged = existingTags.some((t: string) => t.startsWith(SOURCE_TAG_PREFIX));
        const sourceTag = loginSource && !alreadyTagged ? [`${SOURCE_TAG_PREFIX}${loginSource}`] : [];

        updateInput.tags = Array.from(
          new Set([
            ...existingTags.filter((t: string) => !t.startsWith('line_id:')),
            lineTag,
            memberTag,
            ...sourceTag,
          ])
        );
      } else {
        console.error(
          '[Shopify Sync] 🔴 기존 태그 조회 실패 — 태그 전체가 지워질 수 있어 이번에는 메타필드만 저장합니다:',
          JSON.stringify(tagsResult?.errors ?? tagsResult)
        );
      }

      const updateResult = await adminGraphQL(adminToken, `
        mutation SaveLineId($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }
      `, { input: updateInput });

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
  let loginSource: LoginSource | null = null;
  if (typeof state === 'string' && state.includes('.')) {
    const verified = verifySignedState(state, channelSecret);
    if (!verified) {
      console.error('[LINE Callback] 🔴 state 서명 검증 실패 (위조 또는 만료)');
      return res.status(400).json({ message: 'ログインの有効期限が切れました。もう一度お試しください。' });
    }
    returnTo = verified.returnTo;
    loginSource = verified.src;
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
    const shopifyResult = await syncLineUserToShopify(
      {
        userId: profile.userId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
        email,
      },
      loginSource
    );

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
      // 주문 조회·이메일 등록 API 의 인증 수단. Storefront 토큰 발급이 실패한
      // 계정(초기 가입자 일부)도 이걸로 본인 확인이 되므로 기능이 막히지 않는다.
      lineSessionToken: signSessionToken(
        profile.userId,
        shopifyResult.shopifyCustomerId,
        channelSecret
      ),
      returnTo,
    });
  } catch (error) {
    console.error('[LINE Callback] Error:', error);
    return res.status(500).json({ message: 'An error occurred. Please try again.' });
  }
}
