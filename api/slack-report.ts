import type { VercelRequest, VercelResponse } from '@vercel/node';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing REPORT_SHOPIFY_CLIENT_ID or REPORT_SHOPIFY_CLIENT_SECRET');
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text.substring(0, 300)}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken!;
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const response = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Admin API error (${response.status}): ${text.substring(0, 300)}`);
  }

  return response.json();
}

function toJST(date: Date): Date {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

function formatJPY(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function getDateRanges() {
  const nowUTC = new Date();
  const nowJST = toJST(nowUTC);

  // Today (JST)
  const todayStart = new Date(Date.UTC(
    nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate()
  ));
  todayStart.setTime(todayStart.getTime() - 9 * 60 * 60 * 1000); // Convert back to UTC

  // Yesterday (JST)
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

  // This week (Monday start, JST)
  const dayOfWeek = nowJST.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(todayStart.getTime() - mondayOffset * 24 * 60 * 60 * 1000);

  // This month (JST)
  const monthStart = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), 1));
  monthStart.setTime(monthStart.getTime() - 9 * 60 * 60 * 1000);

  return {
    today: todayStart.toISOString(),
    yesterday: yesterdayStart.toISOString(),
    weekStart: weekStart.toISOString(),
    monthStart: monthStart.toISOString(),
    now: nowUTC.toISOString(),
  };
}

interface OrderMetrics {
  count: number;
  revenue: number;
}

async function fetchOrderMetrics(token: string, createdAtMin: string, createdAtMax: string): Promise<OrderMetrics> {
  const query = `
    query OrderMetrics($query: String!) {
      orders(first: 250, query: $query) {
        edges {
          node {
            id
            totalPriceSet {
              shopMoney {
                amount
              }
            }
          }
        }
      }
    }
  `;

  const filterQuery = `created_at:>='${createdAtMin}' AND created_at:<='${createdAtMax}' AND financial_status:paid`;
  const data = await adminGraphQL(token, query, { query: filterQuery });

  const orders = data.data?.orders?.edges || [];
  const revenue = orders.reduce((sum: number, edge: { node: { totalPriceSet: { shopMoney: { amount: string } } } }) => {
    return sum + parseFloat(edge.node.totalPriceSet.shopMoney.amount);
  }, 0);

  return { count: orders.length, revenue };
}

async function fetchTopProducts(token: string, createdAtMin: string): Promise<Array<{ title: string; quantity: number; revenue: number }>> {
  const query = `
    query TopProducts($query: String!) {
      orders(first: 250, query: $query) {
        edges {
          node {
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  originalTotalSet {
                    shopMoney {
                      amount
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

  const filterQuery = `created_at:>='${createdAtMin}' AND financial_status:paid`;
  const data = await adminGraphQL(token, query, { query: filterQuery });

  const productMap = new Map<string, { quantity: number; revenue: number }>();
  const orders = data.data?.orders?.edges || [];

  for (const order of orders) {
    for (const item of order.node.lineItems.edges) {
      const title = item.node.title;
      const existing = productMap.get(title) || { quantity: 0, revenue: 0 };
      existing.quantity += item.node.quantity;
      existing.revenue += parseFloat(item.node.originalTotalSet.shopMoney.amount);
      productMap.set(title, existing);
    }
  }

  return Array.from(productMap.entries())
    .map(([title, data]) => ({ title, ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
}

async function fetchLowStockProducts(token: string): Promise<Array<{ title: string; variant: string; quantity: number }>> {
  const query = `
    query LowStock {
      productVariants(first: 100, query: "inventory_quantity:<5 AND inventory_quantity:>=0") {
        edges {
          node {
            title
            inventoryQuantity
            product {
              title
            }
          }
        }
      }
    }
  `;

  const data = await adminGraphQL(token, query);
  const variants = data.data?.productVariants?.edges || [];

  return variants.map((edge: { node: { product: { title: string }; title: string; inventoryQuantity: number } }) => ({
    title: edge.node.product.title,
    variant: edge.node.title === 'Default Title' ? '' : edge.node.title,
    quantity: edge.node.inventoryQuantity,
  }));
}

function buildSlackMessage(
  today: OrderMetrics,
  yesterday: OrderMetrics,
  week: OrderMetrics,
  month: OrderMetrics,
  topProducts: Array<{ title: string; quantity: number; revenue: number }>,
  lowStock: Array<{ title: string; variant: string; quantity: number }>,
) {
  const nowJST = toJST(new Date());
  const dateStr = `${nowJST.getUTCFullYear()}/${String(nowJST.getUTCMonth() + 1).padStart(2, '0')}/${String(nowJST.getUTCDate()).padStart(2, '0')}`;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `BITEME JAPAN 日次レポート (${dateStr})` },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*本日*\n${today.count}件 / ${formatJPY(today.revenue)}` },
        { type: 'mrkdwn', text: `*昨日*\n${yesterday.count}件 / ${formatJPY(yesterday.revenue)}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*今週*\n${week.count}件 / ${formatJPY(week.revenue)}` },
        { type: 'mrkdwn', text: `*今月*\n${month.count}件 / ${formatJPY(month.revenue)}` },
      ],
    },
  ];

  // Today vs yesterday comparison
  if (yesterday.revenue > 0) {
    const revenueChange = ((today.revenue - yesterday.revenue) / yesterday.revenue * 100).toFixed(1);
    const arrow = today.revenue >= yesterday.revenue ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${arrow} 前日比 売上 *${revenueChange}%*` }],
    });
  }

  // Top products this month
  if (topProducts.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*今月の売れ筋 TOP5*' },
    });

    const productLines = topProducts.map((p, i) =>
      `${i + 1}. ${p.title} — ${p.quantity}個 / ${formatJPY(p.revenue)}`
    ).join('\n');

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: productLines },
    });
  }

  // Low stock alerts
  if (lowStock.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':warning: *在庫アラート (5個未満)*' },
    });

    const stockLines = lowStock.slice(0, 10).map(p => {
      const name = p.variant ? `${p.title} (${p.variant})` : p.title;
      const emoji = p.quantity === 0 ? ':red_circle:' : ':large_orange_circle:';
      return `${emoji} ${name} — 残り *${p.quantity}個*`;
    }).join('\n');

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: stockLines },
    });
  }

  return { blocks };
}

async function sendToSlack(message: { blocks: unknown[] }) {
  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${text}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow GET (cron) and POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Simple auth check for manual triggers
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Allow Vercel cron (no auth header but has x-vercel-cron header)
    if (!req.headers['x-vercel-cron']) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const token = await getAccessToken();
    const dates = getDateRanges();

    const [today, yesterday, week, month, topProducts, lowStock] = await Promise.all([
      fetchOrderMetrics(token, dates.today, dates.now),
      fetchOrderMetrics(token, dates.yesterday, dates.today),
      fetchOrderMetrics(token, dates.weekStart, dates.now),
      fetchOrderMetrics(token, dates.monthStart, dates.now),
      fetchTopProducts(token, dates.monthStart),
      fetchLowStockProducts(token),
    ]);

    const message = buildSlackMessage(today, yesterday, week, month, topProducts, lowStock);
    await sendToSlack(message);

    return res.status(200).json({ ok: true, metrics: { today, yesterday, week, month } });
  } catch (error) {
    console.error('[Slack Report] Error:', error);
    return res.status(500).json({
      error: 'Report generation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
