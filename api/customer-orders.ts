/**
 * /api/customer-orders
 *
 * Storefront API の customer クエリ (2025-07で不安定) を使わず、
 * Admin API で顧客の注文を取得するプロキシエンドポイント。
 *
 * Flow:
 *  1. フロントから shopifyCustomerToken を受け取る
 *  2. Storefront API で customerAccessToken を検証 → email 取得
 *  3. Admin API で email に紐づく注文を取得して返す
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

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

  const { customerAccessToken, shopifyCustomerId, lineUserId } = req.body || {};
  // shopifyCustomerId か lineUserId があれば Admin API で直接解決できるので token は任意
  const hasIdentifier = (shopifyCustomerId && typeof shopifyCustomerId === 'string')
    || (lineUserId && typeof lineUserId === 'string')
    || (customerAccessToken && typeof customerAccessToken === 'string');
  if (!hasIdentifier) {
    return res.status(400).json({ error: 'customerAccessToken, shopifyCustomerId, or lineUserId is required' });
  }

  try {
    // 顧客 GID を解決する (3段階フォールバック)
    const resolveCustomerId = async (): Promise<string | null> => {
      // 1. authStore の GID で Admin API を直接確認 (マージ後に消えていないか検証)
      if (shopifyCustomerId && typeof shopifyCustomerId === 'string') {
        const check = await adminGraphQL(ADMIN_CUSTOMER_ORDERS_QUERY, { customerId: shopifyCustomerId, cursor: null });
        if (check?.data?.customer !== null) return shopifyCustomerId;
        console.warn('[customer-orders] stored GID not found, falling back');
      }

      // 2. LINE userId → 決定論的メールアドレスで顧客を検索 (tag: の : がShopify構文と衝突するため email検索に変更)
      if (lineUserId && typeof lineUserId === 'string') {
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
        `, { query: `tag:line_id:${lineUserId}` });
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
    do {
      const adminData = await adminGraphQL(ADMIN_CUSTOMER_ORDERS_QUERY, { customerId, cursor });
      const edges = adminData?.data?.customer?.orders?.edges || [];
      allOrders.push(...edges.map((e: { node: unknown }) => e.node));
      cursor = adminData?.data?.customer?.orders?.pageInfo?.hasNextPage
        ? adminData?.data?.customer?.orders?.pageInfo?.endCursor
        : null;
    } while (cursor && allOrders.length < 200);

    // LINE メールによるゲスト注文も検索してマージ (customerAccessToken なしでの checkout 分)
    if (lineUserId && typeof lineUserId === 'string') {
      const lineEmail = `line_${lineUserId}@line-user.biteme.co.jp`;
      try {
        const emailData = await adminGraphQL(ORDERS_BY_EMAIL_QUERY, { query: `email:${lineEmail}`, cursor: null });
        const emailEdges = emailData?.data?.orders?.edges || [];
        const existingIds = new Set(allOrders.map((o: unknown) => (o as { id: string }).id));
        for (const e of emailEdges) {
          if (!existingIds.has(e.node.id)) {
            allOrders.push(e.node);
            existingIds.add(e.node.id);
          }
        }
      } catch (err) {
        _debug.emailError = String(err);
      }
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
