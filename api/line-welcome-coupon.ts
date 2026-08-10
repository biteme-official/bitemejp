/**
 * /api/line-welcome-coupon
 *
 * LINE 로그인한 고객에게 **그 사람만 쓸 수 있는 1회용 쿠폰**을 발급한다.
 *
 * 공개 코드(WELCOME10)를 로그인 보상으로 쓰면 로그인하지 않아도 코드만 알면 쓸 수 있다.
 * Shopify 고객 세그먼트로 제한해봤지만 헤드리스 구조에서는 게이트가 되지 않는다 —
 * 우리 프론트가 익명 카트를 넘기므로 결제 시 고객이 식별되지 않아 세그먼트 조건을
 * 판정할 대상 자체가 없다(2026-08-10 실측: 비로그인 결제화면에서도 10% 적용됨).
 *
 * 그래서 `customerSelection` 에 고객 ID 를 직접 박은 코드를 1인당 하나씩 발급한다.
 * 유출돼도 지정된 고객 외에는 쓸 수 없다.
 *
 * 인증: /api/line-callback 이 서명한 lineSessionToken. 클라이언트가 보낸 고객 ID 는 쓰지 않는다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'hihtsp-0m.myshopify.com';
const SHOPIFY_API_VERSION = '2025-07';

/** 발급한 쿠폰을 기록해 재로그인 시 중복 발급을 막는다 */
const COUPON_METAFIELD = { namespace: 'custom', key: 'line_welcome_coupon' };

const DISCOUNT_PERCENTAGE = 0.1;
const VALID_DAYS = 7;

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

/** api/line-callback.ts 의 signSessionToken 과 한 쌍 */
function verifySessionToken(
  token: unknown,
  secret: string
): { lineUserId: string; shopifyCustomerId: string | null } | null {
  if (typeof token !== 'string') return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.e !== 'number' || Date.now() > payload.e) return null;
    if (typeof payload?.u !== 'string' || !payload.u) return null;
    return { lineUserId: payload.u, shopifyCustomerId: typeof payload.c === 'string' ? payload.c : null };
  } catch {
    return null;
  }
}

async function getAdminToken(): Promise<string> {
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing REPORT_SHOPIFY credentials');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Admin token failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

/** 사람이 읽고 옮겨 적을 수 있게 짧고 헷갈리지 않는 문자만 쓴다 (0/O, 1/I 제외) */
function generateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `LINE-${body}`;
}

interface StoredCoupon {
  code: string;
  expiresAt: string;
}

function parseStored(value: string | null | undefined): StoredCoupon | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.code !== 'string' || typeof parsed?.expiresAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    console.error('[Welcome Coupon] 🔴 LINE_CHANNEL_SECRET 미설정');
    return res.status(500).json({ message: 'Server configuration error' });
  }

  const session = verifySessionToken(req.body?.lineSessionToken, channelSecret);
  if (!session) {
    return res.status(401).json({ message: 'ログイン情報が無効です。' });
  }

  try {
    const adminToken = await getAdminToken();

    // 고객 GID 는 서명된 페이로드에서만 얻는다. 없으면 line_id 태그로 찾는다.
    let customerId = session.shopifyCustomerId;
    let storedRaw: string | null = null;

    if (customerId) {
      const found = await adminGraphQL(adminToken, `
        query CouponState($id: ID!) {
          customer(id: $id) {
            id
            metafield(namespace: "${COUPON_METAFIELD.namespace}", key: "${COUPON_METAFIELD.key}") { value }
          }
        }
      `, { id: customerId });
      if (!found?.data?.customer?.id) {
        customerId = null;
      } else {
        storedRaw = found.data.customer.metafield?.value ?? null;
      }
    }

    if (!customerId) {
      const byTag = await adminGraphQL(adminToken, `
        query ByTag($query: String!) {
          customers(first: 1, query: $query) {
            edges { node {
              id
              metafield(namespace: "${COUPON_METAFIELD.namespace}", key: "${COUPON_METAFIELD.key}") { value }
            } }
          }
        }
      `, { query: `tag:"line_id:${session.lineUserId}"` });
      const node = byTag?.data?.customers?.edges?.[0]?.node;
      if (!node?.id) {
        console.error('[Welcome Coupon] 🔴 대상 고객을 찾지 못했습니다:', session.lineUserId);
        return res.status(404).json({ message: 'アカウントが見つかりませんでした。' });
      }
      customerId = node.id;
      storedRaw = node.metafield?.value ?? null;
    }

    // 이미 유효한 쿠폰이 있으면 그대로 돌려준다 (재로그인 때마다 새로 만들지 않는다)
    const stored = parseStored(storedRaw);
    if (stored && Date.parse(stored.expiresAt) > Date.now()) {
      return res.status(200).json({ code: stored.code, expiresAt: stored.expiresAt, reused: true });
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000);
    const code = generateCode();

    const created = await adminGraphQL(adminToken, `
      mutation CreateWelcomeCoupon($input: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $input) {
          codeDiscountNode { id }
          userErrors { field message code }
        }
      }
    `, {
      input: {
        title: `LINE会員クーポン ${code}`,
        code,
        startsAt: now.toISOString(),
        endsAt: endsAt.toISOString(),
        // 이 고객만 쓸 수 있다. 코드가 유출돼도 다른 사람은 사용 불가.
        customerSelection: { customers: { add: [customerId] } },
        customerGets: { value: { percentage: DISCOUNT_PERCENTAGE }, items: { all: true } },
        appliesOncePerCustomer: true,
        usageLimit: 1,
        // 주문 단위 할인끼리는 겹치지 않게 한다 (어필리에이트 코드와 이중 적용 방지).
        // 상품/배송 단위 자동할인과는 함께 적용된다.
        combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
      },
    });

    const userErrors = created?.data?.discountCodeBasicCreate?.userErrors ?? [];
    if (created?.errors || userErrors.length > 0 || !created?.data?.discountCodeBasicCreate?.codeDiscountNode?.id) {
      console.error(
        '[Welcome Coupon] 🔴 쿠폰 생성 실패 (write_discounts 스코프를 확인하세요):',
        JSON.stringify(created?.errors ?? userErrors)
      );
      return res.status(500).json({ message: 'クーポンの発行に失敗しました。' });
    }

    // 발급 기록. 실패해도 쿠폰은 이미 유효하므로 응답은 성공으로 돌려준다.
    // ⚠️ tags 는 보내지 않는다 — customerUpdate 의 tags 는 전체 교체라 기존 태그가 날아간다.
    const saved = await adminGraphQL(adminToken, `
      mutation SaveCoupon($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }
    `, {
      input: {
        id: customerId,
        metafields: [{
          namespace: COUPON_METAFIELD.namespace,
          key: COUPON_METAFIELD.key,
          value: JSON.stringify({ code, expiresAt: endsAt.toISOString() }),
          type: 'single_line_text_field',
        }],
      },
    });
    const saveErrors = saved?.data?.customerUpdate?.userErrors ?? [];
    if (saved?.errors || saveErrors.length > 0) {
      console.error(
        '[Welcome Coupon] 🔴 발급 기록 실패 — 재로그인 시 쿠폰이 중복 생성될 수 있습니다:',
        JSON.stringify(saved?.errors ?? saveErrors)
      );
    }

    console.log('[Welcome Coupon] 발급 완료:', customerId);
    return res.status(200).json({ code, expiresAt: endsAt.toISOString(), reused: false });
  } catch (error) {
    console.error('[Welcome Coupon] 🔴', error);
    return res.status(500).json({ message: 'クーポンの発行に失敗しました。' });
  }
}
