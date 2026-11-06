import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SHOPIFY_API_VERSION } from './_shopify-api-version.js';

/**
 * 최근 30일 인기 상품 — 주문을 직접 세어 판매 수량순 상품 id 를 돌려준다.
 *
 * Storefront 의 BEST_SELLING 은 기간을 정할 수 없고 누적에 가까워, 11월에도 여름 상품이
 * 위에 남는다. 그래서 Admin 주문을 읽어 센다. 취소·테스트 주문은 빼고, 환불·수량 변경은
 * currentQuantity 로 반영한다.
 *
 * 판매 수량은 공개하지 않고 순서(상품 id)만 내보낸다. 결과는 CDN 에 1시간 캐시한다.
 * 실패하면 502 를 돌려주고, 프론트는 BEST_SELLING 으로 돌아간다.
 *
 * ⚠️ 필요 스코프: REPORT 앱에 `read_orders`. 60일이 넘는 기간은 `read_all_orders` 도 필요하다.
 */

const DAYS = 30;
const LIMIT = 250;
/** 100건씩 최근 주문부터 읽는 상한 — 넘치면 오래된 주문만 빠진다 */
const MAX_PAGES = 30;

const ORDERS_QUERY = `
  query RecentOrders($after: String, $query: String) {
    orders(first: 100, after: $after, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        cancelledAt
        test
        lineItems(first: 50) {
          nodes { currentQuantity product { id } }
        }
      }
    }
  }
`;

interface OrdersPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: {
    cancelledAt: string | null;
    test: boolean;
    lineItems: { nodes: { currentQuantity: number; product: { id: string } | null }[] };
  }[];
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(shop: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) return cachedToken;

  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing REPORT_SHOPIFY_CLIENT_ID or REPORT_SHOPIFY_CLIENT_SECRET');
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  cachedToken = data.access_token as string;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function fetchOrdersPage(shop: string, token: string, after: string | null, query: string): Promise<OrdersPage> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: ORDERS_QUERY, variables: { after, query } }),
  });
  if (!res.ok) throw new Error(`Admin API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.errors || !json.data?.orders) throw new Error(`Admin API error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data.orders as OrdersPage;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
    const token = await getAccessToken(shop);
    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
    const query = `processed_at:>=${since}`;

    const sold = new Map<string, number>();
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const orders: OrdersPage = await fetchOrdersPage(shop, token, after, query);
      for (const order of orders.nodes) {
        if (order.cancelledAt || order.test) continue;
        for (const line of order.lineItems.nodes) {
          if (!line.product) continue;
          sold.set(line.product.id, (sold.get(line.product.id) ?? 0) + line.currentQuantity);
        }
      }
      if (!orders.pageInfo.hasNextPage) break;
      after = orders.pageInfo.endCursor;
    }

    const ids = [...sold.entries()]
      .filter(([, quantity]) => quantity > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMIT)
      .map(([id]) => id);

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ days: DAYS, ids });
  } catch (error) {
    console.error('popular-products failed:', error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Failed to load popular products' });
  }
}
