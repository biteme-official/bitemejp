/**
 * /api/affiliate-partner — 파트너 본인 화면(/partner) 데이터·조작 (#178 Phase 2, 설계 §7)
 *
 *   POST { lineSessionToken }                                   → 내 성과
 *   POST { lineSessionToken, action: 'withdraw' }               → 참가 종료 (第12条 1항) — 즉시 링크 무효
 *   POST { lineSessionToken, action: 'invoice', invoiceRegNo }  → 適格請求書発行事業者 등록번호 (第3条 3항), 빈 값이면 삭제
 *
 * 규칙
 *  - 🔴 본인 확인은 서명 세션에서만. 파트너를 LINE userId 로 찾는다.
 *  - 성과 정보는 건수·금액·일시뿐 — 구매자를 특정할 수 있는 것은 절대 내보내지 않는다 (第10条 3항).
 *  - 조회는 GET 이 아니라 POST — 토큰이 URL·로그에 남지 않게.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, isAffiliateEnabled, publicPartner, verifyLineSession, type AffPartner } from './_affiliate.js';
import { disablePartnerCodes } from './_affiliate-campaign.js';
import { activeNotices } from './_affiliate-notice.js';

const ALLOWED_ORIGINS = ['https://biteme.co.jp', 'https://www.biteme.co.jp', 'http://localhost:5173'];
const RECENT_LIMIT = 50;

function getCorsOrigin(req: VercelRequest): string {
  const origin = String(req.headers.origin ?? '');
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

/** 이달 1일 00:00 JST */
function monthStartJst(): string {
  const now = new Date(Date.now() + 9 * 3600_000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 9 * 3600_000).toISOString();
}

interface ConvRow {
  order_name: string | null;
  attribution: string;
  eligible_amount: number;
  commission: number;
  status: string;
  ordered_at: string;
  confirm_at: string;
  confirmed_at: string | null;
}

async function buildView(partner: AffPartner) {
  const sb = getSupabase();
  const since = monthStartJst();
  const [clicksQ, convQ, campQ, codesQ, payoutsQ] = await Promise.all([
    sb.from('aff_clicks').select('id', { count: 'exact', head: true }).eq('partner_id', partner.id).eq('is_bot', false).gte('ts', since),
    sb.from('aff_conversions').select('order_name, attribution, eligible_amount, commission, status, ordered_at, confirm_at, confirmed_at')
      .eq('partner_id', partner.id).order('ordered_at', { ascending: false }).limit(RECENT_LIMIT),
    sb.from('aff_campaigns').select('id, name, starts_at, ends_at, commission_rate, discount_percent, scope, target_ids')
      .eq('active', true).lte('starts_at', new Date().toISOString()).gte('ends_at', new Date().toISOString()),
    sb.from('aff_campaign_codes').select('campaign_id, shopify_code, status').eq('partner_id', partner.id).eq('status', 'active'),
    sb.from('aff_payouts').select('period, gross, withholding, net, status, paid_at, dispute_until').eq('partner_id', partner.id).order('period', { ascending: false }).limit(12),
  ]);
  const firstErr = [clicksQ, convQ, campQ, codesQ, payoutsQ].find((q) => q.error)?.error;
  if (firstErr) throw new Error(firstErr.message);
  const notices = await activeNotices(sb);

  const conversions = (convQ.data ?? []) as ConvRow[];
  const inMonth = conversions.filter((c) => c.ordered_at >= since);
  const sum = (rows: ConvRow[], pred: (c: ConvRow) => boolean) => rows.filter(pred).reduce((s, c) => s + c.commission, 0);

  // 퍼널 4단 (설계 §7): 클릭 → 주문 → 확정 → 지급
  const funnel = {
    clicks: clicksQ.count ?? 0,
    orders: inMonth.filter((c) => c.status === 'pending' || c.status === 'confirmed').length,
    confirmed: inMonth.filter((c) => c.status === 'confirmed').length,
    paid: ((payoutsQ.data ?? []) as Array<{ status: string }>).filter((p) => p.status === 'paid').length,
  };
  const commission = {
    pendingThisMonth: sum(inMonth, (c) => c.status === 'pending'),
    confirmedThisMonth: sum(inMonth, (c) => c.status === 'confirmed'),
    pendingTotal: sum(conversions, (c) => c.status === 'pending'),
    confirmedUnpaid: sum(conversions, (c) => c.status === 'confirmed'),
  };

  // 적용 중인 캠페인 — 전원 대상이거나 나를 지정한 것만. 남의 캠페인 조건은 보여주지 않는다
  const codeByCampaign = new Map(((codesQ.data ?? []) as Array<{ campaign_id: number; shopify_code: string }>).map((c) => [c.campaign_id, c.shopify_code]));
  const campaigns = ((campQ.data ?? []) as Array<{ id: number; name: string; starts_at: string; ends_at: string; commission_rate: number; discount_percent: number | null; scope: string; target_ids: string[] }>)
    .filter((c) => c.scope === 'all' || (c.scope === 'partners' && (c.target_ids ?? []).includes(String(partner.id))) || c.scope === 'products')
    .map((c) => ({ name: c.name, startsAt: c.starts_at, endsAt: c.ends_at, commissionRate: Number(c.commission_rate), discountPercent: c.discount_percent, scope: c.scope, code: codeByCampaign.get(c.id) ?? null,
      // 상품 한정 캠페인만 대상 상품 id 를 준다 — 상품 페이지가 「이 상품은 n%」를 계산한다. 상품 id 는 공개 정보
      targetIds: c.scope === 'products' ? (c.target_ids ?? []).map((t) => String(t).split('/').pop() ?? String(t)) : [] }));

  return {
    ok: true,
    partner: publicPartner(partner),
    monthStart: since,
    funnel,
    commission,
    // 구매자 식별 정보 없음 — 주문번호·금액·일시·상태만
    recent: conversions.map((c) => ({ order: c.order_name, attribution: c.attribution, amount: c.eligible_amount, commission: c.commission, status: c.status, orderedAt: c.ordered_at, confirmAt: c.confirm_at })),
    campaigns,
    payouts: payoutsQ.data ?? [],
    notices: notices.map((n) => ({ title: n.title, body: n.body, effectiveAt: n.effective_at, termsVersion: n.terms_version })),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!isAffiliateEnabled()) return res.status(503).json({ error: 'disabled' });

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).json({ error: 'server_misconfigured' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const session = verifyLineSession(body.lineSessionToken, secret);
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('aff_partners').select('*').eq('line_user_id', session.lineUserId).maybeSingle();
    if (error) throw new Error(error.message);
    const partner = data as AffPartner | null;
    if (!partner) return res.status(404).json({ error: 'not_partner' });

    const action = typeof body.action === 'string' ? body.action : null;

    if (action === 'withdraw') {
      if (partner.status === 'withdrawn') return res.status(200).json({ ok: true, partner: publicPartner(partner) });
      const { error: upErr } = await sb.from('aff_partners')
        .update({ status: 'withdrawn', withdrawn_at: new Date().toISOString() }).eq('id', partner.id);
      if (upErr) throw new Error(upErr.message);
      // 살아 있는 터치는 더 이상 이 파트너에게 귀속되지 않게 지운다 (第12条 4항: 종료 즉시 링크 무효)
      await sb.from('aff_touches').delete().eq('partner_id', partner.id);
      await disablePartnerCodes(sb, partner.id);
      console.log(`[Affiliate] 탈퇴 ${partner.code}`);
      return res.status(200).json({ ok: true, partner: publicPartner({ ...partner, status: 'withdrawn' }) });
    }

    if (action === 'invoice') {
      const raw = typeof body.invoiceRegNo === 'string' ? body.invoiceRegNo.replace(/[\s-]/g, '').toUpperCase() : '';
      // 適格請求書発行事業者登録番号: T + 13자리
      if (raw && !/^T\d{13}$/.test(raw)) return res.status(400).json({ error: 'invalid_invoice_no' });
      const { error: upErr } = await sb.from('aff_partners').update({ invoice_reg_no: raw || null }).eq('id', partner.id);
      if (upErr) throw new Error(upErr.message);
      return res.status(200).json({ ok: true, partner: publicPartner({ ...partner, invoice_reg_no: raw || null }) });
    }

    if (partner.status !== 'active') {
      // 정지·탈퇴 파트너도 자기 명세는 본다 (第12条 1항 — 확정분은 지급)
      const view = await buildView(partner);
      return res.status(200).json(view);
    }
    return res.status(200).json(await buildView(partner));
  } catch (err) {
    console.error('[Affiliate] 🔴 파트너 API 실패:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'internal' });
  }
}
