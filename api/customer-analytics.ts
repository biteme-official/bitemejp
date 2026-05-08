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
  if (!clientId || !clientSecret) throw new Error('Missing Shopify credentials');

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Token error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken!;
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Admin API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function toJSTDate(isoString: string): string {
  const d = new Date(new Date(isoString).getTime() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function getRangeStart(range: string): string {
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const days: Record<string, number> = { today: 0, '7d': 6, '28d': 27, '90d': 89 };
  const offset = days[range] ?? 6;
  const start = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate() - offset));
  return new Date(start.getTime() - 9 * 60 * 60 * 1000).toISOString();
}

// 총 회원 수 + 세그먼트 카운트 (lightweight)
const SEGMENT_COUNTS_QUERY = `
  query CustomerSegments {
    total: customersCount { count }
    noOrders: customersCount(query: "orders_count:=0") { count }
    oneOrder: customersCount(query: "orders_count:=1") { count }
    fourPlusOrders: customersCount(query: "orders_count:>=4") { count }
  }
`;

// 기간 내 신규 가입 고객
const NEW_CUSTOMERS_QUERY = `
  query NewCustomers($query: String!, $cursor: String) {
    customers(first: 250, query: $query, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          numberOfOrders
          amountSpent { amount }
        }
      }
    }
  }
`;

interface CustomerEdge {
  node: {
    id: string;
    createdAt: string;
    numberOfOrders: number;
    amountSpent: { amount: string };
  };
}

async function fetchNewCustomers(token: string, rangeStart: string): Promise<CustomerEdge[]> {
  const filterQuery = `created_at:>='${rangeStart}'`;
  const all: CustomerEdge[] = [];
  let cursor: string | null = null;

  do {
    const data = await adminGraphQL(token, NEW_CUSTOMERS_QUERY, { query: filterQuery, cursor });
    const edges: CustomerEdge[] = data.data?.customers?.edges || [];
    all.push(...edges);
    cursor = data.data?.customers?.pageInfo?.hasNextPage
      ? data.data?.customers?.pageInfo?.endCursor
      : null;
  } while (cursor && all.length < 2000);

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

  if (!isCustom && !['today', '7d', '28d', '90d'].includes(range)) {
    return res.status(400).json({ error: 'Invalid range' });
  }

  try {
    const token = await getAccessToken();
    const jstMidnightUTC = (dateStr: string) =>
      new Date(new Date(`${dateStr}T00:00:00+09:00`).getTime()).toISOString();
    const rangeStart = isCustom ? jstMidnightUTC(fromParam!) : getRangeStart(range);

    const [segmentData, newCustomers] = await Promise.all([
      adminGraphQL(token, SEGMENT_COUNTS_QUERY),
      fetchNewCustomers(token, rangeStart),
    ]);

    // 세그먼트 카운트
    const total = segmentData.data?.total?.count ?? 0;
    const noOrders = segmentData.data?.noOrders?.count ?? 0;
    const oneOrder = segmentData.data?.oneOrder?.count ?? 0;
    const fourPlusOrders = segmentData.data?.fourPlusOrders?.count ?? 0;
    const twoThreeOrders = Math.max(0, total - noOrders - oneOrder - fourPlusOrders);
    const purchasedCustomers = oneOrder + twoThreeOrders + fourPlusOrders;
    const repeatCustomers = twoThreeOrders + fourPlusOrders;

    // 일별 신규 가입 추이
    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStr = nowJST.toISOString().slice(0, 10);
    const dailyMap = new Map<string, number>();
    for (const edge of newCustomers) {
      const date = toJSTDate(edge.node.createdAt);
      dailyMap.set(date, (dailyMap.get(date) || 0) + 1);
    }

    const dailyNewCustomers: { date: string; count: number }[] = [];
    if (isCustom) {
      const cur = new Date(fromParam!);
      const end = new Date(toParam! <= todayStr ? toParam! : todayStr);
      while (cur <= end) {
        const dateStr = cur.toISOString().slice(0, 10);
        dailyNewCustomers.push({ date: dateStr, count: dailyMap.get(dateStr) || 0 });
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      const days: Record<string, number> = { today: 0, '7d': 6, '28d': 27, '90d': 89 };
      const offset = days[range] ?? 6;
      for (let i = offset; i >= 0; i--) {
        const d = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate() - i));
        const dateStr = d.toISOString().slice(0, 10);
        dailyNewCustomers.push({ date: dateStr, count: dailyMap.get(dateStr) || 0 });
      }
    }

    // 신규 고객 중 구매한 고객의 평균 LTV
    const purchasedNew = newCustomers.filter(e => e.node.numberOfOrders > 0);
    const avgNewLTV = purchasedNew.length > 0
      ? Math.round(purchasedNew.reduce((s, e) => s + parseFloat(e.node.amountSpent.amount), 0) / purchasedNew.length)
      : 0;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json({
      totalCustomers: total,
      newCustomersCount: newCustomers.length,
      repeatCustomers,
      repeatRate: purchasedCustomers > 0 ? repeatCustomers / purchasedCustomers : 0,
      segments: { noOrders, oneOrder, twoThreeOrders, fourPlusOrders },
      avgNewLTV,
      dailyNewCustomers,
    });
  } catch (error) {
    console.error('[Customer Analytics]', error);
    return res.status(500).json({
      error: 'Failed to fetch customer analytics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
