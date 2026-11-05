/**
 * /api/line-bf-coupon — 블랙프라이데이 2026 「LINE 친구 5%」 전용 쿠폰 받기 (#274)
 *
 * 블프 기간엔 전 상품 15% 가 Shopify 자동 할인으로 모두에게 붙고, LINE 공식계정 친구에게만 5% 를 더 준다.
 * 5% 는 친구 추가를 늘리려는 장치라 **친구인 것이 서버에서 확인된 사람에게만** 코드를 준다.
 *
 *   POST { lineSessionToken }
 *     → 200 { status: 'not_friend' }                       친구가 아님(차단 포함) — 화면이 친구추가를 안내
 *     → 200 { status: 'ok', code, startsAt, endsAt }       받음(이미 받았으면 같은 코드를 그대로 돌려준다)
 *     → 401 세션 무효 · 409 no_customer · 410 ended · 503 friend_check_failed(LINE 확인 실패 — 다시 시도)
 *
 * 코드 규칙
 *  - 사람마다 하나. 코드 문자열은 userId 의 HMAC 으로 정해진다 → 저장소 없이 「이미 받았나」를 Shopify 조회 한 번으로 안다.
 *    동시에 두 번 눌러 둘 다 만들려 해도 두 번째는 코드 중복으로 실패하고 조회로 돌아간다.
 *  - 그 고객만 쓸 수 있다(context.customers) + 1회(usageLimit 1). 코드가 밖으로 새도 다른 사람은 못 쓴다.
 *  - 상품 할인(전 상품 15% 자동 할인)과는 합산, 다른 주문 할인(WELCOME10 등)과는 합산하지 않는다.
 *    「WELCOME10 과 둘 중 큰 쪽 하나」(11/3 결정)는 결제 때 cartStore 가 코드를 하나만 넣어 지킨다.
 *  - action: 'lookup' 은 이미 받은 코드만 찾아 준다(새로 발급·친구 확인 없음). 쿠폰을 받은 기기와 다른
 *    기기·브라우저에서 결제할 때 cartStore 가 부른다. 코드는 userId 로 정해지므로 서버에 따로 저장하지 않는다.
 *  - 코드 유효기간은 연장 최대치(11/22)까지 잡아 둔다. 실제로 결제에 자동으로 붙는 기간은
 *    src/lib/bfCoupon.ts 의 BF_APPLY_END 가 정한다 — 연장이 정해지면 그 한 줄만 바꾼다.
 *
 * 🔴 userId 는 서명된 lineSessionToken 에서만 꺼낸다(재입고·오픈 알림과 같은 검증).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac } from 'crypto';
import { adminGraphQL, getAdminToken } from './line-campaign.js';
import { getCorsOrigin, isFriend, verifySessionToken } from './line-restock.js';

/** 코드가 쓰이기 시작하는 때 = 블프 오픈 (JST) */
const CODE_STARTS_AT = '2026-11-09T10:00:00+09:00';
/** 코드 만료 = 연장 최대치. 결제 자동 적용 기간은 src/lib/bfCoupon.ts 가 따로 정한다 */
const CODE_ENDS_AT = '2026-11-22T23:59:59+09:00';
/** 이때가 지나면 새로 받지 못한다 */
const CLAIM_ENDS_AT = Date.parse(CODE_ENDS_AT);
const PERCENT = 5;

interface UserError { field?: string[] | null; message: string; code?: string | null }

/** userId → BF5-XXXXXXXXXX. 같은 사람은 언제나 같은 코드 */
export function bfCodeFor(lineUserId: string, secret: string): string {
  const h = createHmac('sha256', secret).update(`bf2026:${lineUserId}`).digest('hex').slice(0, 10).toUpperCase();
  return `BF5-${h}`;
}

async function findCustomerGid(token: string, lineUserId: string): Promise<string | null> {
  // api/customer-orders.ts 와 같은 순서 — LINE 합성 이메일 → line_id 태그
  const queries = [`email:"line_${lineUserId}@line-user.biteme.co.jp"`, `tag:"line_id:${lineUserId}"`];
  for (const query of queries) {
    const r = await adminGraphQL<{ data?: { customers?: { edges: { node: { id: string } }[] } }; errors?: unknown }>(
      token,
      `query($query: String!) { customers(first: 1, query: $query) { edges { node { id } } } }`,
      { query },
    );
    if (r.errors) throw new Error(`customer lookup: ${JSON.stringify(r.errors).slice(0, 200)}`);
    const id = r.data?.customers?.edges?.[0]?.node?.id;
    if (id) return id;
  }
  return null;
}

/** 코드가 없으면 null. used 는 Shopify 사용 횟수 기준이라 주문 직후엔 잠깐 늦을 수 있다 */
async function findCode(token: string, code: string): Promise<{ used: boolean } | null> {
  const r = await adminGraphQL<{
    data?: { codeDiscountNodeByCode: { codeDiscount?: { asyncUsageCount?: number } } | null };
    errors?: unknown;
  }>(
    token,
    `query($code: String!) {
      codeDiscountNodeByCode(code: $code) { codeDiscount { ... on DiscountCodeBasic { asyncUsageCount } } }
    }`,
    { code },
  );
  if (r.errors) throw new Error(`code lookup: ${JSON.stringify(r.errors).slice(0, 200)}`);
  const node = r.data?.codeDiscountNodeByCode;
  return node ? { used: (node.codeDiscount?.asyncUsageCount ?? 0) > 0 } : null;
}

async function createCode(token: string, code: string, customerGid: string, lineUserId: string): Promise<'created' | 'taken'> {
  const r = await adminGraphQL<{
    data?: { discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: UserError[] } };
    errors?: unknown;
  }>(
    token,
    `mutation($d: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $d) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      d: {
        title: `[BF2026] LINE友だち${PERCENT}% · ${lineUserId.slice(-6)}`,
        code,
        startsAt: CODE_STARTS_AT,
        endsAt: CODE_ENDS_AT,
        context: { customers: { add: [customerGid] } },
        customerGets: { value: { percentage: PERCENT / 100 }, items: { all: true } },
        appliesOncePerCustomer: true,
        usageLimit: 1,
        combinesWith: { productDiscounts: true, orderDiscounts: false, shippingDiscounts: true },
      },
    },
  );
  if (r.errors) throw new Error(`code create: ${JSON.stringify(r.errors).slice(0, 300)}`);
  const out = r.data?.discountCodeBasicCreate;
  if (out?.codeDiscountNode) return 'created';
  const errs = out?.userErrors ?? [];
  if (errs.some((e) => e.code === 'TAKEN' || /taken|already|使用|既に/i.test(e.message))) return 'taken';
  throw new Error(`code create: ${errs.map((e) => e.message).join(' / ') || 'unknown'}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).json({ error: 'server_config' });

  const { lineSessionToken, action } = (req.body ?? {}) as Record<string, unknown>;
  const session = verifySessionToken(lineSessionToken, secret);
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  if (Date.now() > CLAIM_ENDS_AT) return res.status(410).json({ error: 'ended' });

  if (action === 'lookup') {
    try {
      const code = bfCodeFor(session.lineUserId, secret);
      const found = await findCode(await getAdminToken(), code);
      return res.status(200).json(found ? { status: 'ok', code, used: found.used } : { status: 'none' });
    } catch (e) {
      console.error('[BF coupon] 🔴 조회 실패:', e);
      return res.status(500).json({ error: 'failed' });
    }
  }

  const friend = await isFriend(session.lineUserId);
  if (friend === null) return res.status(503).json({ error: 'friend_check_failed' });
  if (!friend) return res.status(200).json({ status: 'not_friend' });

  try {
    const token = await getAdminToken();
    const code = bfCodeFor(session.lineUserId, secret);

    if (!(await findCode(token, code))) {
      const customerGid = await findCustomerGid(token, session.lineUserId);
      if (!customerGid) {
        console.warn(`[BF coupon] 고객 없음 …${session.lineUserId.slice(-6)}`);
        return res.status(409).json({ error: 'no_customer' });
      }
      const r = await createCode(token, code, customerGid, session.lineUserId);
      console.log(`[BF coupon] ${r === 'created' ? '발급' : '이미 있음(동시 요청)'} ${code}`);
    }

    return res.status(200).json({ status: 'ok', code, startsAt: CODE_STARTS_AT, endsAt: CODE_ENDS_AT });
  } catch (e) {
    console.error('[BF coupon] 🔴 발급 실패:', e);
    return res.status(500).json({ error: 'failed' });
  }
}
