import type { VercelRequest, VercelResponse } from '@vercel/node';

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

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
  const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
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

function toJST(isoString: string): string {
  const d = new Date(new Date(isoString).getTime() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// paid, partially_refunded, refunded 모두 포함
const FINANCIAL_STATUS_FILTER =
  'financial_status:paid OR financial_status:partially_refunded OR financial_status:refunded';

const ORDERS_QUERY = `
  query ExportOrders($query: String!, $cursor: String) {
    orders(first: 250, query: $query, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          financialStatus
          totalShippingPriceSet { shopMoney { amount } }
          lineItems(first: 50) {
            edges {
              node {
                title
                variantTitle
                quantity
                originalUnitPriceSet { shopMoney { amount } }
                originalTotalSet { shopMoney { amount } }
                refundableQuantity
              }
            }
          }
        }
      }
    }
  }
`;

interface LineItemNode {
  title: string;
  variantTitle: string | null;
  quantity: number;
  originalUnitPriceSet: { shopMoney: { amount: string } };
  originalTotalSet: { shopMoney: { amount: string } };
  refundableQuantity: number;
}

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  totalShippingPriceSet: { shopMoney: { amount: string } };
  lineItems: { edges: { node: LineItemNode }[] };
}

async function fetchAllOrders(token: string): Promise<OrderNode[]> {
  const all: OrderNode[] = [];
  let cursor: string | null = null;

  do {
    const data = await adminGraphQL(token, ORDERS_QUERY, {
      query: FINANCIAL_STATUS_FILTER,
      cursor,
    });
    const edges: { node: OrderNode }[] = data.data?.orders?.edges || [];
    all.push(...edges.map((e) => e.node));
    cursor = data.data?.orders?.pageInfo?.hasNextPage
      ? data.data?.orders?.pageInfo?.endCursor
      : null;
  } while (cursor && all.length < 5000);

  return all;
}

function escapeCsv(value: string | number | null | undefined): string {
  const str = value == null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(orders: OrderNode[]): string {
  const headers = [
    'order_number',
    'created_at_jst',
    'financial_status',
    'shipping_fee',
    'product_name',
    'variant',
    'quantity',
    'unit_price',
    'line_total',
  ];

  const rows: string[] = [headers.join(',')];

  for (const order of orders) {
    const shippingFee = parseFloat(order.totalShippingPriceSet.shopMoney.amount);
    const createdAt = toJST(order.createdAt);

    // 첫 번째 라인아이템에만 배송비를 넣고 나머지는 0 (중복 집계 방지)
    order.lineItems.edges.forEach(({ node: item }, idx) => {
      const row = [
        escapeCsv(order.name),
        escapeCsv(createdAt),
        escapeCsv(order.financialStatus),
        escapeCsv(idx === 0 ? shippingFee : 0),
        escapeCsv(item.title),
        escapeCsv(item.variantTitle && item.variantTitle !== 'Default Title' ? item.variantTitle : ''),
        escapeCsv(item.quantity),
        escapeCsv(parseFloat(item.originalUnitPriceSet.shopMoney.amount)),
        escapeCsv(parseFloat(item.originalTotalSet.shopMoney.amount)),
      ];
      rows.push(row.join(','));
    });
  }

  return rows.join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    return res.status(200).end();
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!ADMIN_SECRET || req.headers.authorization !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getAccessToken();
    const orders = await fetchAllOrders(token);
    const csv = buildCsv(orders);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders-export.csv"');
    return res.status(200).send('\uFEFF' + csv); // BOM 추가 → Excel/Sheets 한글 깨짐 방지
  } catch (error) {
    console.error('[Orders Export]', error);
    return res.status(500).json({
      error: 'Failed to export orders',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
