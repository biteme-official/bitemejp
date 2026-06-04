import type { VercelRequest, VercelResponse } from '@vercel/node';

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) return cachedToken;

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
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
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken!;
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const res = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Admin API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// JST 기준 날짜 문자열 반환 ("YYYY-MM-DD")
function toJSTDate(isoString: string): string {
  const d = new Date(new Date(isoString).getTime() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// range → JST 기준 ISO 시작 시각 (UTC)
function getRangeStart(range: string): string {
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const days: Record<string, number> = { today: 0, '7d': 6, '28d': 27, '90d': 89 };
  const offset = days[range] ?? 6;
  const start = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate() - offset));
  // convert back to UTC (JST midnight = UTC -9h)
  return new Date(start.getTime() - 9 * 60 * 60 * 1000).toISOString();
}

const ORDERS_QUERY = `
  query Orders($query: String!, $cursor: String) {
    orders(first: 250, query: $query, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          totalPriceSet { shopMoney { amount } }
          lineItems(first: 50) {
            edges {
              node {
                title
                quantity
                product { id }
                originalTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

const LOW_STOCK_QUERY = `
  query LowStock {
    productVariants(first: 100, query: "inventory_quantity:<5 AND inventory_quantity:>=0") {
      edges {
        node {
          title
          inventoryQuantity
          product { title }
        }
      }
    }
  }
`;

interface OrderEdge {
  node: {
    id: string;
    createdAt: string;
    totalPriceSet: { shopMoney: { amount: string } };
    lineItems: {
      edges: { node: { title: string; quantity: number; product: { id: string } | null; originalTotalSet: { shopMoney: { amount: string } } } }[];
    };
  };
}

async function fetchAllOrders(token: string, rangeStart: string): Promise<OrderEdge[]> {
  const filterQuery = `created_at:>='${rangeStart}' AND financial_status:paid`;
  const all: OrderEdge[] = [];
  let cursor: string | null = null;

  do {
    const data = await adminGraphQL(token, ORDERS_QUERY, { query: filterQuery, cursor });
    const edges: OrderEdge[] = data.data?.orders?.edges || [];
    all.push(...edges);
    cursor = data.data?.orders?.pageInfo?.hasNextPage
      ? data.data?.orders?.pageInfo?.endCursor
      : null;
  } while (cursor && all.length < 1000);

  return all;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!ADMIN_SECRET || req.headers.authorization !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const range = (req.query.range as string) || '7d';
  const fromParam = req.query.from as string | undefined;
  const toParam = req.query.to as string | undefined;
  const isCustom = range === 'custom' && !!fromParam && !!toParam;

  if (!isCustom) {
    const validRanges = ['today', '7d', '28d', '90d'];
    if (!validRanges.includes(range)) return res.status(400).json({ error: 'Invalid range' });
  }

  try {
    const token = await getAccessToken();
    // JST 날짜 문자열(YYYY-MM-DD) → JST 자정의 UTC ISO
    const jstMidnightUTC = (dateStr: string) =>
      new Date(new Date(`${dateStr}T00:00:00+09:00`).getTime()).toISOString();
    const rangeStart = isCustom ? jstMidnightUTC(fromParam!) : getRangeStart(range);

    const [orders, lowStockData] = await Promise.all([
      fetchAllOrders(token, rangeStart),
      adminGraphQL(token, LOW_STOCK_QUERY),
    ]);

    // 일별 집계
    const dailyMap = new Map<string, { orders: number; revenue: number }>();
    // productMap 키: Shopify product GID (정확한 매칭용)
    const productMap = new Map<string, { title: string; quantity: number; revenue: number }>();
    let totalRevenue = 0;
    let totalItems = 0;

    for (const edge of orders) {
      const date = toJSTDate(edge.node.createdAt);
      const rev = parseFloat(edge.node.totalPriceSet.shopMoney.amount);
      totalRevenue += rev;

      const day = dailyMap.get(date) || { orders: 0, revenue: 0 };
      day.orders += 1;
      day.revenue += rev;
      dailyMap.set(date, day);

      for (const item of edge.node.lineItems.edges) {
        const productId = item.node.product?.id ?? `title:${item.node.title}`;
        const qty = item.node.quantity;
        const itemRev = parseFloat(item.node.originalTotalSet.shopMoney.amount);
        totalItems += qty;
        const existing = productMap.get(productId) || { title: item.node.title, quantity: 0, revenue: 0 };
        existing.quantity += qty;
        existing.revenue += itemRev;
        productMap.set(productId, existing);
      }
    }

    // 날짜 채우기 (데이터 없는 날도 0으로)
    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStr = nowJST.toISOString().slice(0, 10);
    const dailyOrders = [];

    if (isCustom) {
      const cur = new Date(fromParam!);
      const end = new Date(toParam! <= todayStr ? toParam! : todayStr);
      while (cur <= end) {
        const dateStr = cur.toISOString().slice(0, 10);
        const entry = dailyMap.get(dateStr) || { orders: 0, revenue: 0 };
        dailyOrders.push({ date: dateStr, orders: entry.orders, revenue: Math.round(entry.revenue) });
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      const days: Record<string, number> = { today: 0, '7d': 6, '28d': 27, '90d': 89 };
      const offset = days[range] ?? 6;
      for (let i = offset; i >= 0; i--) {
        const d = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate() - i));
        const dateStr = d.toISOString().slice(0, 10);
        const entry = dailyMap.get(dateStr) || { orders: 0, revenue: 0 };
        dailyOrders.push({ date: dateStr, orders: entry.orders, revenue: Math.round(entry.revenue) });
      }
    }

    const topProducts = Array.from(productMap.entries())
      .map(([productId, d]) => ({ productId, title: d.title, quantity: d.quantity, revenue: Math.round(d.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const lowStock = (lowStockData.data?.productVariants?.edges || [])
      .map((e: { node: { product: { title: string }; title: string; inventoryQuantity: number } }) => ({
        title: e.node.product.title,
        variant: e.node.title === 'Default Title' ? '' : e.node.title,
        quantity: e.node.inventoryQuantity,
      }))
      .sort((a: { quantity: number }, b: { quantity: number }) => a.quantity - b.quantity);

    return res.status(200).json({
      summary: {
        totalOrders: orders.length,
        totalRevenue: Math.round(totalRevenue),
        averageOrderValue: orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0,
        totalItemsSold: totalItems,
      },
      dailyOrders,
      topProducts,
      lowStock,
    });
  } catch (error) {
    console.error('[Shopify Analytics]', error);
    return res.status(500).json({
      error: 'Failed to fetch Shopify analytics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
