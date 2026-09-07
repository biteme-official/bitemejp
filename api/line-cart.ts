/**
 * /api/line-cart — 로그인 고객의 장바구니 스냅샷을 남긴다.
 *
 * Shopify 의 `abandonedCheckout` 은 **결제창까지 들어간 사람**만 잡는다. 담기만 하고 결제창에
 * 가지 않으면 우리 쪽에 기록이 아예 없어서, 장바구니 이탈 저니가 그 사람을 볼 수 없다.
 * 2026-09-04 담기 이벤트 때 GA4 장바구니 담기는 293 → 1,341 로 뛰었는데 결제창 이탈은
 * 15 → 16 이었다. 담기 단계는 지금까지 통째로 사각지대였다.
 *
 * 그래서 카트가 바뀔 때마다 브라우저가 여기에 스냅샷을 던지고, `cart_add` 저니가 그걸 읽는다.
 *
 * 🔴 클라이언트가 보낸 LINE userId 는 절대 믿지 않는다. 서명된 `lineSessionToken` 에서만
 *    꺼낸다 — 안 그러면 아무나 남의 userId 를 실어 보내 우리가 그 사람에게 LINE 메시지를
 *    쏘게 만들 수 있다. 이 엔드포인트는 발송 트리거이지 단순 로그가 아니다.
 *
 * 카트 내용(상품·수량)은 검증하지 않는다. 자기 카트를 지어내 봐야 자기가 받을 메시지에
 * 자기가 넣은 상품이 적히는 것뿐이고, 복구 링크도 자기 브라우저에서 열린다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const CART_EVENT = 'line_cart';

/** 한 카트에서 읽어 둘 최대 줄 수. 문안에는 첫 줄만 쓰고 나머지는 「ほか N点」이 된다. */
const MAX_LINES = 20;

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

export interface CartLine {
  /** gid://shopify/Product/<숫자> */
  productId: string;
  /** gid://shopify/ProductVariant/<숫자> */
  variantId: string;
  quantity: number;
  title: string;
}

/** api/line-callback.ts 의 signSessionToken 과 한 쌍 */
function verifySessionToken(token: unknown, secret: string): { lineUserId: string } | null {
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
    return { lineUserId: payload.u };
  } catch {
    return null;
  }
}

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** 형식이 어긋난 줄은 버린다. 카트를 통째로 거절하면 나머지 정상 줄까지 못 남긴다. */
export function sanitizeLines(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return [];
  const out: CartLine[] = [];
  for (const r of raw.slice(0, MAX_LINES)) {
    if (!r || typeof r !== 'object') continue;
    const { productId, variantId, quantity, title } = r as Record<string, unknown>;
    if (typeof productId !== 'string' || !PRODUCT_GID.test(productId)) continue;
    if (typeof variantId !== 'string' || !VARIANT_GID.test(variantId)) continue;
    const q = Math.floor(Number(quantity));
    if (!Number.isFinite(q) || q < 1 || q > 99) continue;
    out.push({
      productId,
      variantId,
      quantity: q,
      title: typeof title === 'string' ? title.slice(0, 120) : '',
    });
  }
  return out;
}

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).json({ error: 'LINE_CHANNEL_SECRET 미설정' });

  const { lineSessionToken, items } = (req.body ?? {}) as {
    lineSessionToken?: unknown;
    items?: unknown;
  };

  const session = verifySessionToken(lineSessionToken, secret);
  // 비로그인 방문자는 그냥 무시한다. 400 을 주면 브라우저 콘솔이 빨개질 뿐 할 수 있는 게 없다.
  if (!session) return res.status(200).json({ ok: true, skipped: 'no-session' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: 'SUPABASE 미설정' });

  const lines = sanitizeLines(items);
  const { error } = await createClient(url, key).from('events').insert({
    event_type: CART_EVENT,
    // line-campaign 의 발송 기록과 같은 키 규칙 — 저니가 두 쪽을 같이 읽는다
    session_id: `line:${session.lineUserId}`,
    // 빈 배열도 남긴다. "카트를 비웠다"가 발송을 멈추는 신호이기 때문이다.
    properties: { items: lines, count: lines.reduce((s, l) => s + l.quantity, 0) },
    page_path: null,
    referrer: null,
  });

  if (error) {
    console.error('[LINE Cart] 스냅샷 저장 실패:', error.message);
    return res.status(500).json({ error: 'Failed to record' });
  }

  return res.status(200).json({ ok: true, lines: lines.length });
}
