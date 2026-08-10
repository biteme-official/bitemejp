import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';

// Vercel 자동 JSON 파싱 비활성화 — HMAC 검증에 raw body 필요
export const config = { api: { bodyParser: false } };

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA4_MEASUREMENT_ID = 'G-WLTZH90W2L';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'hihtsp-0m.myshopify.com';
const SHOPIFY_API_VERSION = '2025-07';

/**
 * ⚠️ 이 도메인은 MX 레코드가 없어 메일이 전량 바운스된다.
 *    그래서 이 유저들에게는 LINE 이 유일한 연락 수단이다.
 */
const PLACEHOLDER_EMAIL_DOMAIN = '@line-user.biteme.co.jp';

/** LINE 매핑·발송기록 메타필드는 모두 이 네임스페이스에 있다 (api/line-callback.ts 와 동일) */
const METAFIELD_NAMESPACE = 'custom';
/** 중복 발송 방지용 — 마지막으로 알림을 보낸 주문을 고객에 기록한다 */
const NOTIFIED_KEY = 'line_last_order_notified';

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
  email?: string | null;
  order_status_url?: string | null;
  customer?: { id: number; email?: string | null } | null;
}

/** fulfillments/create 웹훅 페이로드 (필요한 필드만) */
interface ShopifyFulfillment {
  id: number;
  order_id: number;
  name?: string | null;
  tracking_company?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  email?: string | null;
  line_items?: ShopifyLineItem[];
}

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * 웹훅 서명 검증.
 *
 * ⚠️ 서명에 쓰이는 비밀키가 **웹훅을 어디서 등록했는지에 따라 다르다.**
 *  - Shopify 관리자 > 설정 > 알림 에서 등록 → 스토어 웹훅 서명 비밀키 (SHOPIFY_WEBHOOK_SECRET)
 *  - Admin API 로 앱이 등록          → 그 앱의 client secret (REPORT_SHOPIFY_CLIENT_SECRET)
 *
 * 기존 orders/create 는 전자, 배송 알림용 fulfillments/create 는 후자로 등록할 수 있어
 * 둘 다 허용한다. 어느 경로로 등록하든 동작하므로 등록 방법에 발이 묶이지 않는다.
 */
function verifyHmac(rawBody: string, signature: string, secrets: string[]): boolean {
  const received = Buffer.from(signature, 'base64');
  return secrets.some((secret) => {
    const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    return computed.length === received.length && timingSafeEqual(computed, received);
  });
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

// ── LINE 알림 ────────────────────────────────────────────────────────────────

// 한 요청에서 여러 번 쓰이므로 캐시한다 (api/customer-orders.ts 와 같은 방식)
let cachedAdminToken: string | null = null;
let adminTokenExpiresAt = 0;

async function getAdminToken(): Promise<string> {
  if (cachedAdminToken && Date.now() < adminTokenExpiresAt) return cachedAdminToken;

  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing REPORT_SHOPIFY credentials');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Admin token failed: ${res.status}`);
  const data = await res.json();
  cachedAdminToken = data.access_token;
  adminTokenExpiresAt = Date.now() + 30 * 60 * 1000;
  return data.access_token;
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

/** 자리표시자 이메일에는 LINE userId 가 로컬파트에 그대로 들어있다 */
function extractLineUserId(email: string | null | undefined): string | null {
  if (!email || !email.endsWith(PLACEHOLDER_EMAIL_DOMAIN)) return null;
  const localPart = email.slice(0, -PLACEHOLDER_EMAIL_DOMAIN.length);
  if (!localPart.startsWith('line_')) return null;
  const userId = localPart.slice('line_'.length);
  return /^U[0-9a-f]{32}$/.test(userId) ? userId : null;
}

interface LineTarget {
  lineUserId: string;
  /** 있으면 중복 발송 기록을 남길 수 있다 */
  customerGid: string | null;
  lastNotifiedOrderId: string | null;
}

/**
 * 주문의 고객에게서 LINE userId 를 찾는다.
 *
 * 1) 자리표시자 이메일이면 로컬파트에서 바로 얻는다 (Admin 호출 없음)
 * 2) 실제 이메일로 바뀐 유저는 Admin 으로 `custom.line_id` 메타필드 / `line_id:` 태그를 본다
 *
 * LINE 유저가 아니면 null 이다 — 대부분의 주문이 여기 해당하므로 오류가 아니다.
 */
async function resolveLineTarget(
  email: string | null | undefined,
  customerId: number | null | undefined
): Promise<LineTarget | null> {
  if (!customerId) {
    const fromEmail = extractLineUserId(email);
    return fromEmail ? { lineUserId: fromEmail, customerGid: null, lastNotifiedOrderId: null } : null;
  }

  const customerGid = `gid://shopify/Customer/${customerId}`;
  const adminToken = await getAdminToken();
  const result = await adminGraphQL(adminToken, `
    query LineTarget($id: ID!) {
      customer(id: $id) {
        id
        email
        tags
        lineId: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "line_id") { value }
        lastNotified: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${NOTIFIED_KEY}") { value }
      }
    }
  `, { id: customerGid });

  const customer = result?.data?.customer;
  if (!customer) {
    // 조회 실패와 "LINE 유저가 아님" 을 구분한다 — 전자는 알림이 조용히 누락되는 상황이다.
    console.error('[LINE Notify] 🔴 고객 조회 실패:', JSON.stringify(result?.errors ?? result));
    return null;
  }

  const tag: string | undefined = (customer.tags ?? []).find((t: string) => t.startsWith('line_id:'));
  const lineUserId: string | null =
    customer.lineId?.value
    || (tag ? tag.slice('line_id:'.length) : null)
    || extractLineUserId(customer.email);

  if (!lineUserId) return null;

  return {
    lineUserId,
    customerGid: customer.id,
    lastNotifiedOrderId: customer.lastNotified?.value ?? null,
  };
}

/** 발송 성공을 고객에 기록한다. tags 는 보내지 않는다(전체 교체라 기존 태그가 날아간다). */
async function markNotified(customerGid: string, orderId: number): Promise<void> {
  const adminToken = await getAdminToken();
  const result = await adminGraphQL(adminToken, `
    mutation MarkNotified($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }
  `, {
    input: {
      id: customerGid,
      metafields: [{
        namespace: METAFIELD_NAMESPACE,
        key: NOTIFIED_KEY,
        value: String(orderId),
        type: 'single_line_text_field',
      }],
    },
  });

  const userErrors = result?.data?.customerUpdate?.userErrors ?? [];
  if (result?.errors || userErrors.length > 0) {
    // 기록에 실패해도 메시지는 이미 갔다. 재시도 시 중복 발송될 수 있으므로 남긴다.
    console.error('[LINE Notify] 🔴 발송 기록 실패(중복 발송 가능):', JSON.stringify(result?.errors ?? userErrors));
  }
}

/**
 * LINE 푸시 발송.
 * 친구가 아니거나 차단한 경우 LINE 이 4xx 를 준다 — 오류가 아니라 정상 상황이다.
 */
async function pushLineMessage(lineUserId: string, text: string): Promise<'sent' | 'not-friend' | 'failed'> {
  const token = process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error('[LINE Notify] 🔴 LINE_MESSAGING_CHANNEL_ACCESS_TOKEN 미설정 — 알림을 보내지 못했습니다');
    return 'failed';
  }

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
  });

  if (res.ok) return 'sent';

  const body = await res.text();
  // 403 = 친구가 아니거나 차단. 우리가 고칠 수 있는 게 아니다.
  if (res.status === 403) {
    console.log('[LINE Notify] 친구가 아니어서 발송 생략');
    return 'not-friend';
  }
  console.error(`[LINE Notify] 🔴 push 실패 ${res.status}: ${body.slice(0, 200)}`);
  return 'failed';
}

function formatOrderMessage(order: ShopifyOrder): string {
  const total = Number(order.total_price).toLocaleString('ja-JP');
  const items = order.line_items
    .slice(0, 5)
    .map((i) => `・${i.title}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`)
    .join('\n');
  const more = order.line_items.length > 5 ? `\n・ほか${order.line_items.length - 5}点` : '';

  return [
    'ご注文ありがとうございます！',
    '',
    `注文番号: #${order.order_number}`,
    `合計: ¥${total}`,
    '',
    `${items}${more}`,
    ...(order.order_status_url ? ['', '▼ ご注文状況の確認', order.order_status_url] : []),
  ].join('\n');
}

function formatFulfillmentMessage(f: ShopifyFulfillment, orderNumber: number | null): string {
  const lines = [
    '商品を発送しました！',
    '',
    ...(orderNumber ? [`注文番号: #${orderNumber}`] : []),
  ];

  if (f.tracking_number) {
    lines.push(`配送業者: ${f.tracking_company ?? '―'}`, `お問い合わせ番号: ${f.tracking_number}`);
  }
  if (f.tracking_url) {
    lines.push('', '▼ 配送状況の確認', f.tracking_url);
  }
  return lines.join('\n');
}

/** 주문 확인 알림. 실패해도 절대 throw 하지 않는다 — GA4 전송과 웹훅 200 을 지킨다. */
async function notifyOrderCreated(order: ShopifyOrder): Promise<void> {
  const target = await resolveLineTarget(order.email ?? order.customer?.email, order.customer?.id);
  if (!target) return;

  if (target.lastNotifiedOrderId === String(order.id)) {
    console.log(`[LINE Notify] 이미 발송한 주문 — 건너뜀 #${order.order_number}`);
    return;
  }

  const result = await pushLineMessage(target.lineUserId, formatOrderMessage(order));
  if (result === 'sent') {
    console.log(`[LINE Notify] 주문 확인 발송 완료 #${order.order_number}`);
    if (target.customerGid) await markNotified(target.customerGid, order.id);
  }
}

/** 배송 시작 알림. 주문번호를 얻기 위해 Admin 으로 주문을 한 번 조회한다. */
async function notifyFulfillmentCreated(fulfillment: ShopifyFulfillment): Promise<void> {
  const adminToken = await getAdminToken();
  const orderResult = await adminGraphQL(adminToken, `
    query OrderForFulfillment($id: ID!) {
      order(id: $id) {
        name
        email
        customer { id }
      }
    }
  `, { id: `gid://shopify/Order/${fulfillment.order_id}` });

  const order = orderResult?.data?.order;
  if (!order) {
    console.error('[LINE Notify] 🔴 배송 알림용 주문 조회 실패:', JSON.stringify(orderResult?.errors ?? orderResult));
    return;
  }

  const customerId = order.customer?.id
    ? Number(String(order.customer.id).split('/').pop())
    : null;
  const target = await resolveLineTarget(order.email ?? fulfillment.email, customerId);
  if (!target) return;

  const orderNumber = order.name ? Number(String(order.name).replace('#', '')) : null;
  const result = await pushLineMessage(
    target.lineUserId,
    formatFulfillmentMessage(fulfillment, Number.isFinite(orderNumber) ? orderNumber : null)
  );
  if (result === 'sent') {
    console.log(`[LINE Notify] 배송 알림 발송 완료 ${order.name ?? fulfillment.order_id}`);
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

  // 등록 경로에 따라 서명 비밀키가 다르므로 둘 다 시도한다 (verifyHmac 주석 참고)
  const signingSecrets = [webhookSecret, process.env.REPORT_SHOPIFY_CLIENT_SECRET]
    .filter((s): s is string => !!s);

  if (!verifyHmac(rawBody, signature, signingSecrets)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 배송 시작 알림 — 스토어 설정 > 알림 > 웹훅에 fulfillments/create 등록이 필요하다.
  if (topic === 'fulfillments/create') {
    try {
      await notifyFulfillmentCreated(JSON.parse(rawBody));
    } catch (err) {
      console.error('[LINE Notify] 🔴 배송 알림 처리 중 예외:', err);
    }
    return res.status(200).json({ ok: true });
  }

  if (topic !== 'orders/create') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  let order: ShopifyOrder;
  try {
    order = JSON.parse(rawBody);
  } catch (err) {
    console.error('주문 웹훅 페이로드 파싱 실패:', err);
    return res.status(200).json({ ok: false, error: 'Invalid payload' });
  }

  try {
    await sendGA4Purchase(order, ga4ApiSecret);
    console.log(`GA4 purchase: order #${order.order_number} ${order.total_price} ${order.currency}`);
  } catch (err) {
    console.error('GA4 purchase webhook error:', err);
  }

  // LINE 알림은 GA4 와 독립적으로 처리한다. 한쪽이 실패해도 다른 쪽은 나가야 한다.
  try {
    await notifyOrderCreated(order);
  } catch (err) {
    console.error('[LINE Notify] 🔴 주문 알림 처리 중 예외:', err);
  }

  return res.status(200).json({ ok: true });
}
