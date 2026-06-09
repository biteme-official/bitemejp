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
  const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
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

const ORDERS_QUERY = `
  query UtmOrders($query: String!, $cursor: String) {
    orders(first: 250, query: $query, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          totalPriceSet { shopMoney { amount } }
          customAttributes { key value }
        }
      }
    }
  }
`;

interface OrderNode {
  id: string;
  createdAt: string;
  totalPriceSet: { shopMoney: { amount: string } };
  customAttributes: { key: string; value: string }[];
}

async function fetchAllOrders(token: string, rangeStart: string): Promise<OrderNode[]> {
  const filterQuery = `created_at:>='${rangeStart}' AND financial_status:paid`;
  const all: OrderNode[] = [];
  let cursor: string | null = null;

  do {
    const data = await adminGraphQL(token, ORDERS_QUERY, { query: filterQuery, cursor });
    const edges: { node: OrderNode }[] = data.data?.orders?.edges || [];
    all.push(...edges.map((e) => e.node));
    cursor = data.data?.orders?.pageInfo?.hasNextPage
      ? data.data?.orders?.pageInfo?.endCursor
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

  if (!isCustom) {
    const validRanges = ['today', '7d', '28d', '90d'];
    if (!validRanges.includes(range)) return res.status(400).json({ error: 'Invalid range' });
  }

  try {
    const token = await getAccessToken();
    const jstMidnightUTC = (dateStr: string) =>
      new Date(new Date(`${dateStr}T00:00:00+09:00`).getTime()).toISOString();
    const rangeStart = isCustom ? jstMidnightUTC(fromParam!) : getRangeStart(range);

    const orders = await fetchAllOrders(token, rangeStart);

    // utm_source별 집계
    const sourceMap = new Map<string, { orders: number; revenue: number }>();
    // utm_source × date 집계
    const dailyMap = new Map<string, Map<string, { orders: number; revenue: number }>>();
    // 전체 날짜 목록
    const dateSet = new Set<string>();

    for (const order of orders) {
      const date = toJSTDate(order.createdAt);
      const revenue = parseFloat(order.totalPriceSet.shopMoney.amount);

      // JST 범위 끝 날짜 체크 (custom일 때)
      if (isCustom && toParam && date > toParam) continue;

      dateSet.add(date);

      const utmAttr = order.customAttributes.find((a) => a.key === 'utm_source');
      const utmSource = utmAttr?.value?.trim() || '(없음)';

      // 소스별 집계
      const src = sourceMap.get(utmSource) ?? { orders: 0, revenue: 0 };
      src.orders += 1;
      src.revenue += revenue;
      sourceMap.set(utmSource, src);

      // 날짜별 소스 집계
      if (!dailyMap.has(date)) dailyMap.set(date, new Map());
      const dayMap = dailyMap.get(date)!;
      const dayEntry = dayMap.get(utmSource) ?? { orders: 0, revenue: 0 };
      dayEntry.orders += 1;
      dayEntry.revenue += revenue;
      dayMap.set(utmSource, dayEntry);
    }

    // utm_source 목록 (매출 순)
    const sources = Array.from(sourceMap.entries())
      .map(([source, v]) => ({ source, orders: v.orders, revenue: Math.round(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);

    const totalOrders = sources.reduce((s, r) => s + r.orders, 0);
    const totalRevenue = sources.reduce((s, r) => s + r.revenue, 0);

    // 날짜 목록 채우기 (데이터 없는 날도 포함)
    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStr = nowJST.toISOString().slice(0, 10);
    const allDates: string[] = [];

    if (isCustom && fromParam && toParam) {
      const cur = new Date(fromParam);
      const end = new Date(toParam <= todayStr ? toParam : todayStr);
      while (cur <= end) {
        allDates.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      const days: Record<string, number> = { today: 0, '7d': 6, '28d': 27, '90d': 89 };
      const offset = days[range] ?? 6;
      for (let i = offset; i >= 0; i--) {
        const d = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate() - i));
        allDates.push(d.toISOString().slice(0, 10));
      }
    }

    // 날짜 × 소스 테이블 (소스가 없으면 0)
    const sourceKeys = sources.map((s) => s.source);
    const daily = allDates.map((date) => {
      const dayMap = dailyMap.get(date);
      const row: Record<string, number | string> = { date };
      for (const src of sourceKeys) {
        const entry = dayMap?.get(src);
        row[`${src}__orders`] = entry?.orders ?? 0;
        row[`${src}__revenue`] = entry ? Math.round(entry.revenue) : 0;
      }
      return row;
    });

    return res.status(200).json({
      summary: { totalOrders, totalRevenue },
      sources,
      daily,
      sourceKeys,
    });
  } catch (error) {
    console.error('[UTM Analytics]', error);
    return res.status(500).json({
      error: 'Failed to fetch UTM analytics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
