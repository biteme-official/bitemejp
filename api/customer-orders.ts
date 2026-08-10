/**
 * /api/customer-orders
 *
 * Storefront API の customer クエリ (2025-07で不安定) を使わず、
 * Admin API で顧客の注文を取得するプロキシエンドポイント。
 *
 * 인증 (둘 중 하나 필수):
 *  - lineSessionToken : /api/line-callback 이 LINE 로그인 성공 후 서명해 발급한 토큰
 *  - customerAccessToken : Storefront API 로 검증하는 고객 토큰
 *
 * ⚠️ 서명 없는 shopifyCustomerId / lineUserId 는 받지 않는다.
 *    예전에는 이 둘만 있으면 인증 없이 주문을 내줬고, 고객 GID 는 연속된 숫자라
 *    열거가 가능했다. 응답의 statusPageUrl 로 성명·배송지까지 노출됐다.
 *    조회 대상은 **반드시 서명된 페이로드 또는 검증된 토큰에서만** 얻는다.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
const API_VERSION = '2025-07';

// ── Admin API token (client_credentials) ──────────────────────────────────
let cachedAdminToken: string | null = null;
let adminTokenExpiresAt = 0;

async function getAdminToken(): Promise<string> {
  const now = Date.now();
  if (cachedAdminToken && now < adminTokenExpiresAt - 5 * 60 * 1000) return cachedAdminToken;

  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing REPORT_SHOPIFY credentials');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Admin token error ${res.status}`);
  const data = await res.json();
  cachedAdminToken = data.access_token;
  adminTokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedAdminToken!;
}

// ── Storefront API token (for customer token validation) ──────────────────
let cachedSfToken: string | null = null;
let sfTokenExpiresAt = 0;

async function getStorefrontToken(): Promise<string> {
  const now = Date.now();
  if (cachedSfToken && now < sfTokenExpiresAt - 5 * 60 * 1000) return cachedSfToken;

  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing VITE_SHOPIFY credentials');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Storefront token error ${res.status}`);
  const data = await res.json();
  cachedSfToken = data.access_token;
  sfTokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedSfToken!;
}

async function storefrontQuery(query: string, variables: Record<string, unknown> = {}) {
  const token = await getStorefrontToken();
  const res = await fetch(`https://${SHOP}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Shopify-Storefront-Private-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Storefront API error ${res.status}`);
  return res.json();
}

async function adminGraphQL(query: string, variables: Record<string, unknown> = {}) {
  const token = await getAdminToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Admin API error ${res.status}`);
  return res.json();
}

// Step 1: Storefront API でトークンを検証し、email を取得
const VERIFY_CUSTOMER_QUERY = `
  query VerifyCustomer($customerAccessToken: String!) {
    customer(customerAccessToken: $customerAccessToken) {
      id
      email
    }
  }
`;

// Step 2: Admin API で顧客 GID から注文を直接取得
const ADMIN_CUSTOMER_ORDERS_QUERY = `
  query CustomerOrders($customerId: ID!, $cursor: String) {
    customer(id: $customerId) {
      # id 는 GID 유효성 판정에 쓴다 (없으면 존재 확인이 항상 실패한다)
      id
      email
      orders(first: 50, after: $cursor, sortKey: PROCESSED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            processedAt
            displayFinancialStatus
            displayFulfillmentStatus
            statusPageUrl
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { city province country }
            fulfillments(first: 5) {
              trackingInfo(first: 1) { company number url }
            }
            lineItems(first: 20) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    image { url }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// LINE メールでゲスト注文を検索 (customerAccessToken なしの注文を拾う)
const ORDERS_BY_EMAIL_QUERY = `
  query OrdersByEmail($query: String!, $cursor: String) {
    orders(first: 50, after: $cursor, sortKey: PROCESSED_AT, reverse: true, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          processedAt
          displayFinancialStatus
          displayFulfillmentStatus
          statusPageUrl
          totalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress { city province country }
          fulfillments(first: 5) {
            trackingInfo(first: 1) { company number url }
          }
          lineItems(first: 20) {
            edges {
              node {
                title
                quantity
                variant { image { url } }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * /api/line-callback 이 발급한 세션 토큰을 검증한다.
 * 서명 형식·비밀키는 api/line-callback.ts 의 signSessionToken 과 한 쌍이다.
 */
function verifySessionToken(
  token: unknown,
  secret: string
): { lineUserId: string; shopifyCustomerId: string | null } | null {
  if (typeof token !== 'string') return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.e !== 'number' || Date.now() > payload.e) return null;
    if (typeof payload?.u !== 'string' || !payload.u) return null;
    const c = typeof payload.c === 'string' ? payload.c : null;
    return { lineUserId: payload.u, shopifyCustomerId: c };
  } catch {
    return null;
  }
}

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)
    ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customerAccessToken, lineSessionToken } = req.body || {};

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    console.error('[customer-orders] 🔴 LINE_CHANNEL_SECRET 미설정');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // 신원은 서명된 세션 토큰에서만 얻는다. 클라이언트가 보낸 고객 ID 는 쓰지 않는다.
  const session = verifySessionToken(lineSessionToken, channelSecret);
  const shopifyCustomerId = session?.shopifyCustomerId ?? null;
  const lineUserId = session?.lineUserId ?? null;

  if (!session && !(customerAccessToken && typeof customerAccessToken === 'string')) {
    return res.status(401).json({ error: 'ログイン情報が無効です。もう一度ログインしてください。' });
  }

  try {
    // 顧客 GID を解決する (3段階フォールバック) — 입력은 전부 검증된 값이다.
    const resolveCustomerId = async (): Promise<string | null> => {
      // 1. 서명된 GID 로 Admin API 직접 확인 (고객 병합으로 사라졌는지 검증)
      if (shopifyCustomerId) {
        const check = await adminGraphQL(ADMIN_CUSTOMER_ORDERS_QUERY, { customerId: shopifyCustomerId, cursor: null });
        // ⚠️ `!== null` 로 보면 GraphQL 오류로 data 가 아예 없을 때(undefined)도
        //    검증 통과가 되어 버린다. 고객 id 가 실제로 왔는지로 판정한다.
        if (check?.data?.customer?.id) return shopifyCustomerId;
        console.warn('[customer-orders] stored GID not found, falling back');
      }

      // 2. LINE userId → 決定論的メールアドレスで顧客を検索 (tag: の : がShopify構文と衝突するため email検索に変更)
      if (lineUserId) {
        const lineEmail = `line_${lineUserId}@line-user.biteme.co.jp`;
        const emailResult = await adminGraphQL(`
          query FindByEmail($query: String!) {
            customers(first: 1, query: $query) {
              edges { node { id } }
            }
          }
        `, { query: `email:"${lineEmail}"` });
        const gidByEmail = emailResult?.data?.customers?.edges?.[0]?.node?.id;
        if (gidByEmail) {
          console.log('[customer-orders] Found customer by LINE email:', gidByEmail);
          return gidByEmail;
        }
        // メールで見つからなければタグでも試みる
        const tagResult = await adminGraphQL(`
          query FindByLineTag($query: String!) {
            customers(first: 1, query: $query) {
              edges { node { id } }
            }
          }
        `, { query: `tag:"line_id:${lineUserId}"` });
        const gidByTag = tagResult?.data?.customers?.edges?.[0]?.node?.id;
        if (gidByTag) {
          console.log('[customer-orders] Found customer by LINE tag:', gidByTag);
          return gidByTag;
        }
        console.warn('[customer-orders] LINE email/tag lookup returned no customer');
      }

      // 3. Storefront API でトークン検証 → GID 取得 (token がある場合のみ)
      if (!customerAccessToken) return null;
      const sfData = await storefrontQuery(VERIFY_CUSTOMER_QUERY, { customerAccessToken });
      return sfData?.data?.customer?.id || null;
    };

    const customerId = await resolveCustomerId();
    if (!customerId) {
      return res.status(401).json({ error: 'Could not resolve customer ID' });
    }

    // Admin API で顧客 GID から注文を取得
    const allOrders: unknown[] = [];
    let cursor: string | null = null;
    let shopifyCustomerEmail: string | null = null;
    do {
      const adminData = await adminGraphQL(ADMIN_CUSTOMER_ORDERS_QUERY, { customerId, cursor });
      if (!shopifyCustomerEmail) {
        shopifyCustomerEmail = adminData?.data?.customer?.email || null;
      }
      const edges = adminData?.data?.customer?.orders?.edges || [];
      allOrders.push(...edges.map((e: { node: unknown }) => e.node));
      cursor = adminData?.data?.customer?.orders?.pageInfo?.hasNextPage
        ? adminData?.data?.customer?.orders?.pageInfo?.endCursor
        : null;
    } while (cursor && allOrders.length < 200);

    // ゲスト注文をメールで検索してマージ (customerAccessToken なしでの checkout 分)
    const mergeOrdersByEmail = async (email: string, existingIds: Set<string>) => {
      try {
        const emailData = await adminGraphQL(ORDERS_BY_EMAIL_QUERY, { query: `email:"${email}"`, cursor: null });
        const emailEdges = emailData?.data?.orders?.edges || [];
        for (const e of emailEdges) {
          if (!existingIds.has(e.node.id)) {
            allOrders.push(e.node);
            existingIds.add(e.node.id);
          }
        }
      } catch (err) {
        console.warn(`[customer-orders] email order merge failed (${email}):`, err);
      }
    };

    const existingIds = new Set(allOrders.map((o: unknown) => (o as { id: string }).id));

    // ⚠️ 병합에 쓰는 이메일은 서명된 lineUserId 또는 Admin 조회 결과에서만 온다.
    //    예전에는 프론트가 보낸 userEmail 로도 병합했는데, 그러면 아무 이메일이나
    //    넣어 그 주소의 게스트 주문을 긁어올 수 있었다.
    // 1) LINE 合成メール (line_U...@line-user.biteme.co.jp)
    if (lineUserId) {
      await mergeOrdersByEmail(`line_${lineUserId}@line-user.biteme.co.jp`, existingIds);
    }
    // 2) Shopify顧客の実メール — GID照会で取得したメールでゲスト注文を検索
    if (shopifyCustomerEmail && shopifyCustomerEmail.includes('@')) {
      await mergeOrdersByEmail(shopifyCustomerEmail, existingIds);
    }

    // 日付順に再ソート
    (allOrders as Array<{ processedAt: string }>).sort(
      (a, b) => new Date(b.processedAt).getTime() - new Date(a.processedAt).getTime()
    );

    // フロントの ShopifyOrder 型に合わせて整形
    const orders = (allOrders as Array<{
      id: string;
      name: string;
      processedAt: string;
      displayFinancialStatus: string | null;
      displayFulfillmentStatus: string | null;
      statusPageUrl: string | null;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      shippingAddress: { city?: string; province?: string; country?: string } | null;
      fulfillments: Array<{ trackingInfo: Array<{ company: string | null; number: string; url: string }> }>;
      lineItems: { edges: Array<{ node: { title: string; quantity: number; variant?: { image?: { url: string } } | null } }> };
    }>).map((node) => ({
      id: node.id,
      name: node.name,
      orderNumber: parseInt(node.name.replace('#', ''), 10),
      processedAt: node.processedAt,
      financialStatus: (node.displayFinancialStatus || '').toUpperCase().replace(/ /g, '_'),
      fulfillmentStatus: (node.displayFulfillmentStatus || 'Unfulfilled').toUpperCase().replace(/ /g, '_'),
      statusUrl: node.statusPageUrl,
      totalPrice: {
        amount: node.totalPriceSet.shopMoney.amount,
        currencyCode: node.totalPriceSet.shopMoney.currencyCode,
      },
      shippingAddress: node.shippingAddress,
      fulfillments: (node.fulfillments || []).map((f) => ({
        trackingCompany: f.trackingInfo?.[0]?.company || null,
        trackingNumber: f.trackingInfo?.[0]?.number || null,
        trackingUrl: f.trackingInfo?.[0]?.url || null,
      })),
      lineItems: (node.lineItems?.edges || []).map((li) => ({
        title: li.node.title,
        quantity: li.node.quantity,
        variant: li.node.variant,
      })),
    }));

    return res.status(200).json({ orders });
  } catch (error) {
    console.error('[Customer Orders]', error);
    return res.status(500).json({
      error: 'Failed to fetch customer orders',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
