import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac } from 'crypto';

// Vercel 자동 JSON 파싱 비활성화 — HMAC 검증에 raw body 필요
export const config = { api: { bodyParser: false } };

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA4_MEASUREMENT_ID = 'G-WLTZH90W2L';

interface ShopifyLineItem {
  variant_id: number | null;
  title: string;
  variant_title: string | null;
  quantity: number;
  price: string;
  vendor: string | null;
}

interface ShopifyOrder {
  id: number;
  order_number: number;
  total_price: string;
  currency: string;
  line_items: ShopifyLineItem[];
  shipping_lines: Array<{ price: string }>;
  note_attributes?: Array<{ name: string; value: string }>;
}

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyHmac(rawBody: string, signature: string, secret: string): boolean {
  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return computed === signature;
}

async function sendGA4Purchase(order: ShopifyOrder, apiSecret: string): Promise<void> {
  // cartStore.ts에서 카트 속성으로 전달 → Shopify 주문의 note_attributes에 포함됨
  const attrs = order.note_attributes ?? [];
  const clientId = attrs.find(a => a.name === 'ga_client_id')?.value || `shopify.${order.id}`;
  const sessionId = attrs.find(a => a.name === 'ga_session_id')?.value;
  const utmSource = attrs.find(a => a.name === 'utm_source')?.value;
  const utmMedium = attrs.find(a => a.name === 'utm_medium')?.value;
  const utmCampaign = attrs.find(a => a.name === 'utm_campaign')?.value;

  const shipping = order.shipping_lines.reduce(
    (sum, l) => sum + parseFloat(l.price || '0'), 0
  );

  const items = order.line_items.map((item, index) => ({
    item_id: item.variant_id ? String(item.variant_id) : `item_${index}`,
    item_name: item.title,
    ...(item.vendor ? { item_brand: item.vendor } : {}),
    ...(item.variant_title && item.variant_title !== 'Default Title'
      ? { item_variant: item.variant_title }
      : {}),
    price: parseFloat(item.price),
    quantity: item.quantity,
  }));

  const payload = {
    client_id: clientId,
    events: [
      {
        name: 'purchase',
        params: {
          transaction_id: `shopify_${order.order_number}`,
          value: parseFloat(order.total_price),
          currency: order.currency,
          shipping,
          items,
          // session_id가 있어야 GA4가 세션 attribution(소스/매체)을 정확히 연결함
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(utmSource ? { campaign_source: utmSource } : {}),
          ...(utmMedium ? { campaign_medium: utmMedium } : {}),
          ...(utmCampaign ? { campaign_name: utmCampaign } : {}),
        },
      },
    ],
  };

  const url = `${GA4_ENDPOINT}?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${apiSecret}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`GA4 MP ${res.status}: ${await res.text()}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const ga4ApiSecret = process.env.GA4_API_SECRET;

  if (!webhookSecret || !ga4ApiSecret) {
    console.error('Missing env: SHOPIFY_WEBHOOK_SECRET or GA4_API_SECRET');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const signature = req.headers['x-shopify-hmac-sha256'] as string;
  const topic = req.headers['x-shopify-topic'] as string;

  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = await readRawBody(req);

  if (!verifyHmac(rawBody, signature, webhookSecret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (topic !== 'orders/create') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  try {
    const order: ShopifyOrder = JSON.parse(rawBody);
    await sendGA4Purchase(order, ga4ApiSecret);
    console.log(`GA4 purchase: order #${order.order_number} ${order.total_price} ${order.currency}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('GA4 purchase webhook error:', err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
