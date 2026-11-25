/**
 * /api/line-thanks-coupon — 블프 첫 구매자 「두 번째 구매 ¥500」 쿠폰 조회 (#320)
 *
 * 코드는 `scripts/issue-thanks-coupon.ts` 가 대상자에게 미리 만들어 둔다. 여기서는 새로 발급하지 않고
 * 로그인한 사람의 코드가 있는지·썼는지만 알려준다 — 결제 자동 적용(cartStore)과 마이페이지 카드가 부른다.
 *
 *   POST { lineSessionToken }
 *     → 200 { status: 'none' }                                  대상이 아님(코드 없음)
 *     → 200 { status: 'ok', code, used, startsAt, endsAt }
 *     → 401 세션 무효 · 410 ended · 500 조회 실패
 *
 *   GET (Authorization: Bearer ADMIN_SECRET) — 발급·사용 현황 { issued, used }
 *
 * 🔴 userId 는 서명된 lineSessionToken 에서만 꺼낸다(블프 5%·재입고 알림과 같은 검증).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { adminGraphQL, getAdminToken } from './line-campaign.js';
import { findCustomerGid } from './line-bf-coupon.js';
import { getCorsOrigin, verifySessionToken } from './line-restock.js';
import {
  THANKS_ENDS_AT,
  THANKS_STARTS_AT,
  THANKS_TITLE_PREFIX,
  findThanksCode,
  thanksCodeFor,
} from './_thanks-coupon.js';

async function issuedStats(token: string): Promise<{ issued: number; used: number }> {
  let issued = 0;
  let used = 0;
  let after: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const r: {
      data?: {
        codeDiscountNodes: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { codeDiscount: { title?: string; asyncUsageCount?: number } | null }[];
        };
      };
      errors?: unknown;
    } = await adminGraphQL(
      token,
      `query($a: String) {
        codeDiscountNodes(first: 250, after: $a, query: "title:'${THANKS_TITLE_PREFIX}*'") {
          pageInfo { hasNextPage endCursor }
          nodes { codeDiscount { ... on DiscountCodeBasic { title asyncUsageCount } } }
        }
      }`,
      { a: after },
    );
    if (r.errors || !r.data) throw new Error(`issued list: ${JSON.stringify(r.errors).slice(0, 200)}`);
    for (const n of r.data.codeDiscountNodes.nodes) {
      // 검색은 접두어가 느슨하게 걸린다 — 제목으로 한 번 더 거른다
      if (!n.codeDiscount?.title?.startsWith(THANKS_TITLE_PREFIX)) continue;
      issued++;
      if ((n.codeDiscount.asyncUsageCount ?? 0) > 0) used++;
    }
    const p = r.data.codeDiscountNodes.pageInfo;
    if (!p.hasNextPage) break;
    after = p.endCursor;
  }
  return { issued, used };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const admin = process.env.ADMIN_SECRET;
    if (!admin || req.headers.authorization !== `Bearer ${admin}`) return res.status(401).json({ error: 'Unauthorized' });
    try {
      return res.status(200).json(await issuedStats(await getAdminToken()));
    } catch (e) {
      console.error('[Thanks coupon] 발급 현황 조회 실패:', e);
      return res.status(500).json({ error: 'failed' });
    }
  }

  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).json({ error: 'server_config' });

  const { lineSessionToken } = (req.body ?? {}) as Record<string, unknown>;
  const session = verifySessionToken(lineSessionToken, secret);
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  if (Date.now() > Date.parse(THANKS_ENDS_AT)) return res.status(410).json({ error: 'ended' });

  try {
    const token = await getAdminToken();
    const gid = await findCustomerGid(token, session.lineUserId);
    if (!gid) return res.status(200).json({ status: 'none' });
    const code = thanksCodeFor(gid, secret);
    const found = await findThanksCode(token, code);
    if (!found) return res.status(200).json({ status: 'none' });
    return res.status(200).json({ status: 'ok', code, used: found.used, startsAt: THANKS_STARTS_AT, endsAt: THANKS_ENDS_AT });
  } catch (e) {
    console.error('[Thanks coupon] 🔴 조회 실패:', e);
    return res.status(500).json({ error: 'failed' });
  }
}
