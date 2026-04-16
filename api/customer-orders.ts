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

// Step 2: Admin API で email から顧客の注文を取得
const ADMIN_CUSTOMER_ORDERS_QUERY = `
  query CustomerOrders($query: String!, $cursor: String) {
    orders(first: 50, query: $query, after: $cursor, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          processedAt
          financialStatus
          fulfillmentStatus
          statusUrl
          totalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress { city province country }
          fulfillments(first: 5) {
            trackingCompany
            trackingInfo(first: 1) { number url }
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

  const { customerAccessToken } = req.body || {};
  if (!customerAccessToken || typeof customerAccessToken !== 'string') {
    return res.status(400).json({ error: 'customerAccessToken is required' });
  }

  try {
    // Step 1: トークン検証 & email 取得
    const sfData = await storefrontQuery(VERIFY_CUSTOMER_QUERY, { customerAccessToken });
    const customer = sfData?.data?.customer;

    if (!customer?.email) {
      return res.status(401).json({ error: 'Invalid or expired customer token' });
    }

    const email = customer.email as string;

    // Step 2: Admin API で注文取得 (ページネーション対応)
    const filterQuery = `email:'${email}'`;
    const allOrders: unknown[] = [];
    let cursor: string | null = null;

    do {
      const adminData = await adminGraphQL(ADMIN_CUSTOMER_ORDERS_QUERY, { query: filterQuery, cursor });
      const edges = adminData?.data?.orders?.edges || [];
      allOrders.push(...edges.map((e: { node: unknown }) => e.node));
      cursor = adminData?.data?.orders?.pageInfo?.hasNextPage
        ? adminData?.data?.orders?.pageInfo?.endCursor
        : null;
    } while (cursor && allOrders.length < 200);

    // フロントの ShopifyOrder 型に合わせて整形
    const orders = (allOrders as Array<{
      id: string;
      name: string;
      processedAt: string;
      financialStatus: string;
      fulfillmentStatus: string;
      statusUrl: string | null;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      shippingAddress: { city?: string; province?: string; country?: string } | null;
      fulfillments: Array<{ trackingCompany: string | null; trackingInfo: Array<{ number: string; url: string }> }>;
      lineItems: { edges: Array<{ node: { title: string; quantity: number; variant?: { image?: { url: string } } | null } }> };
    }>).map((node) => ({
      id: node.id,
      name: node.name,
      orderNumber: parseInt(node.name.replace('#', ''), 10),
      processedAt: node.processedAt,
      financialStatus: node.financialStatus,
      fulfillmentStatus: node.fulfillmentStatus || 'UNFULFILLED',
      statusUrl: node.statusUrl,
      totalPrice: {
        amount: node.totalPriceSet.shopMoney.amount,
        currencyCode: node.totalPriceSet.shopMoney.currencyCode,
      },
      shippingAddress: node.shippingAddress,
      fulfillments: (node.fulfillments || []).map((f) => ({
        trackingCompany: f.trackingCompany,
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
