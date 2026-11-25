/**
 * 블프 2026 첫 구매자 「두 번째 구매 쿠폰」 — 서버 공용 (#320)
 *
 * 블프 기간에 처음 산 사람은 대부분 WELCOME10 을 이미 써서 다음 구매에 쓸 혜택이 없다.
 * 두 번째 구매 골든타임(12월 첫째~셋째 주)에 ¥500 OFF(¥3,000 이상) 를 1인 1코드로 준다.
 *
 * 발급은 사람이 받으러 오지 않는다 — `scripts/issue-thanks-coupon.ts` 가 대상자 전원에게 미리 만들어 두고
 * 고객 태그 `thanks500` 을 붙인다. 태그는 LINE 개별 발송(`/api/line-campaign` segment.tag)·메일 세그먼트에 쓴다.
 * 결제 때는 `/api/line-thanks-coupon` 이 로그인한 사람의 코드를 찾아 주고 cartStore 가 자동으로 붙인다.
 *
 * 코드 규칙 (BF5 와 같은 생각)
 *  - 코드 문자열은 **고객 id** 의 HMAC 으로 정해진다 → 저장소 없이 「이 사람 코드」를 언제든 다시 계산한다.
 *    LINE userId 가 아니라 고객 id 인 이유: LINE 이 연결 안 된 첫 구매자(메일 대상)에게도 같은 규칙으로 만든다.
 *  - 그 고객만 쓸 수 있다(context.customers) + 1회(usageLimit 1). 코드가 밖으로 새도 다른 사람은 못 쓴다.
 *  - 상품 할인(자동 할인)·배송 할인과는 합산, 다른 주문 할인(WELCOME10 등)과는 합산하지 않는다.
 *
 * 기간을 바꾸면 여기 두 줄과 src/lib/thanksCoupon.ts 의 같은 값을 같이 바꾼다. 이미 만든 코드는 스크립트를 다시 돌려도
 * 바뀌지 않는다(있으면 건너뜀) — 기간 변경은 Shopify 할인 화면에서 하거나 스크립트에 수정 경로를 추가할 것.
 */
import { createHmac } from 'crypto';
import { adminGraphQL } from './line-campaign.js';

export const THANKS_TITLE_PREFIX = '[THANKS2026]';
export const THANKS_TAG = 'thanks500';
export const THANKS_AMOUNT = 500;
export const THANKS_MIN_SUBTOTAL = 3000;
/** 쓰이기 시작하는 때 — 발송 주(12월 첫째 주) 시작 */
export const THANKS_STARTS_AT = '2026-12-01T00:00:00+09:00';
export const THANKS_ENDS_AT = '2026-12-21T23:59:59+09:00';

/** 대상: 블프 기간 안에 첫 주문을 한 고객 (japan-mall-retro 블프 회고 「첫 구매자」 와 같은 정의) */
export const BF_START = '2026-11-09T10:00:00+09:00';
export const BF_END = '2026-11-22T23:59:59+09:00';

interface UserError { field?: string[] | null; message: string; code?: string | null }

/** gid://shopify/Customer/123 또는 123 → THX500-XXXXXXXXXX. 같은 고객은 언제나 같은 코드 */
export function thanksCodeFor(customerId: string, secret: string): string {
  const id = customerId.split('/').pop() ?? customerId;
  const h = createHmac('sha256', secret).update(`thanks2026:${id}`).digest('hex').slice(0, 10).toUpperCase();
  return `THX500-${h}`;
}

/** 코드가 없으면 null. used 는 Shopify 사용 횟수 기준이라 주문 직후엔 잠깐 늦을 수 있다 */
export async function findThanksCode(token: string, code: string): Promise<{ used: boolean } | null> {
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

export async function createThanksCode(token: string, code: string, customerGid: string): Promise<'created' | 'taken'> {
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
        title: `${THANKS_TITLE_PREFIX} 2回目¥${THANKS_AMOUNT} · ${customerGid.split('/').pop()}`,
        code,
        startsAt: THANKS_STARTS_AT,
        endsAt: THANKS_ENDS_AT,
        context: { customers: { add: [customerGid] } },
        customerGets: {
          value: { discountAmount: { amount: String(THANKS_AMOUNT), appliesOnEachItem: false } },
          items: { all: true },
        },
        minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(THANKS_MIN_SUBTOTAL) } },
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
