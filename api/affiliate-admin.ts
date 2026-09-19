/**
 * 어필리에이트 어드민 API (Phase 0 — 읽기 + 파트너 수동 등록)
 *
 *  GET  /api/affiliate-admin              파트너 목록(이달 성과) + 최근 전환 + 캠페인
 *  POST /api/affiliate-admin  action=add_partner
 *       { code, name, instagram?, email?, discountCode? }
 *       Phase 2 셀프 가입 전까지 하영이 어드민에서 파트너를 앉힌다.
 *       discountCode 를 주면 기존 Collabs 할인코드를 「Collabs 이행 코드」 캠페인에 묶어
 *       그 코드가 붙은 주문이 바로 장부에 잡히게 한다.
 *
 * 인증: Authorization: Bearer ADMIN_SECRET (다른 어드민 API 와 동일)
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  BASE_RATE,
  LEGACY_CAMPAIGN_NAME,
  MANUAL_LINE_ID_PREFIX,
  getSupabase,
  isAffiliateEnabled,
  type AffPartner,
} from './_affiliate.js';

const CODE_RE = /^[A-Z0-9]{4,12}$/;

function authorized(req: VercelRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${secret}`;
}

/** JST 기준 이달 1일 00:00 (UTC ISO) */
function monthStartJst(): string {
  const now = new Date(Date.now() + 9 * 3600_000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return new Date(Date.UTC(y, m, 1) - 9 * 3600_000).toISOString();
}

interface ConversionRow {
  id: number;
  order_id: string;
  order_name: string | null;
  partner_id: number;
  attribution: string;
  eligible_amount: number;
  rate: number;
  rate_source: string;
  commission: number;
  status: string;
  ordered_at: string;
  confirm_at: string;
}

async function handleGet(res: VercelResponse) {
  const sb = getSupabase();
  const since = monthStartJst();

  const [partnersQ, monthQ, recentQ, campaignsQ, codesQ] = await Promise.all([
    sb.from('aff_partners').select('*').order('joined_at', { ascending: false }),
    sb.from('aff_conversions').select('partner_id, status, commission, eligible_amount').gte('ordered_at', since),
    sb.from('aff_conversions').select('*').order('ordered_at', { ascending: false }).limit(50),
    sb.from('aff_campaigns').select('*').order('starts_at', { ascending: false }),
    sb.from('aff_campaign_codes').select('partner_id, shopify_code, status, campaign_id'),
  ]);
  const firstError = [partnersQ, monthQ, recentQ, campaignsQ, codesQ].find((q) => q.error)?.error;
  if (firstError) return res.status(500).json({ error: firstError.message });

  type MonthRow = { partner_id: number; status: string; commission: number; eligible_amount: number };
  const stats = new Map<number, { orders: number; sales: number; pending: number; confirmed: number; self: number }>();
  for (const r of (monthQ.data ?? []) as MonthRow[]) {
    const s = stats.get(r.partner_id) ?? { orders: 0, sales: 0, pending: 0, confirmed: 0, self: 0 };
    s.orders += 1;
    s.sales += r.eligible_amount;
    if (r.status === 'pending') s.pending += r.commission;
    if (r.status === 'confirmed') s.confirmed += r.commission;
    if (r.status === 'self') s.self += 1;
    stats.set(r.partner_id, s);
  }

  const codesByPartner = new Map<number, string[]>();
  for (const c of (codesQ.data ?? []) as Array<{ partner_id: number; shopify_code: string; status: string }>) {
    if (c.status !== 'active') continue;
    codesByPartner.set(c.partner_id, [...(codesByPartner.get(c.partner_id) ?? []), c.shopify_code]);
  }

  const partners = ((partnersQ.data ?? []) as AffPartner[]).map((p) => ({
    ...p,
    manual: p.line_user_id.startsWith(MANUAL_LINE_ID_PREFIX),
    codes: codesByPartner.get(p.id) ?? [],
    month: stats.get(p.id) ?? { orders: 0, sales: 0, pending: 0, confirmed: 0, self: 0 },
  }));

  const codeById = new Map(partners.map((p) => [p.id, p.code]));
  const recent = ((recentQ.data ?? []) as ConversionRow[]).map((c) => ({ ...c, partner_code: codeById.get(c.partner_id) ?? '?' }));

  return res.status(200).json({
    ok: true,
    enabled: isAffiliateEnabled(),
    baseRate: BASE_RATE,
    monthStart: since,
    partners,
    recent,
    campaigns: campaignsQ.data ?? [],
  });
}

async function handleAddPartner(body: Record<string, unknown>, res: VercelResponse) {
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  const instagram = String(body.instagram ?? '').trim().replace(/^@/, '') || null;
  const email = String(body.email ?? '').trim().toLowerCase() || null;
  const discountCode = String(body.discountCode ?? '').trim().toUpperCase() || null;

  if (!CODE_RE.test(code)) return res.status(400).json({ error: '코드는 대문자·숫자 4~12자' });
  if (!name) return res.status(400).json({ error: '이름은 필수' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: '이메일 형식이 아님' });

  const sb = getSupabase();
  const now = new Date().toISOString();

  const { data: partner, error: pErr } = await sb
    .from('aff_partners')
    .insert({
      code,
      line_user_id: `${MANUAL_LINE_ID_PREFIX}${code}`,
      name,
      instagram,
      email,
      status: 'active',
      terms_version: 'manual',     // 어드민 수동 등록 — 약관 동의는 Phase 2 LINE 가입 시 갈아탐
      agreed_at: now,
      adult_confirmed_at: now,
      memo: '어드민 수동 등록',
    })
    .select('*')
    .single();
  if (pErr) {
    const dup = pErr.code === '23505';
    return res.status(dup ? 409 : 500).json({ error: dup ? '이미 있는 코드' : pErr.message });
  }

  let legacyCode: string | null = null;
  if (discountCode) {
    // 「Collabs 이행 코드」 캠페인 — 없으면 만든다. 기본 요율과 같은 10%, 종료 없음
    let { data: camp } = await sb.from('aff_campaigns').select('id, target_ids').eq('name', LEGACY_CAMPAIGN_NAME).maybeSingle();
    if (!camp) {
      const created = await sb
        .from('aff_campaigns')
        .insert({
          name: LEGACY_CAMPAIGN_NAME,
          starts_at: '2026-01-01T00:00:00Z',
          ends_at: '2099-12-31T00:00:00Z',
          commission_rate: BASE_RATE,
          discount_percent: null,
          scope: 'partners',
          target_ids: [],
          active: true,
          created_by: 'system',
        })
        .select('id, target_ids')
        .single();
      if (created.error) return res.status(500).json({ error: created.error.message, partner });
      camp = created.data;
    }
    const ids = new Set<string>((camp.target_ids as string[]) ?? []);
    ids.add(String(partner.id));
    await sb.from('aff_campaigns').update({ target_ids: [...ids] }).eq('id', camp.id);

    const { error: cErr } = await sb.from('aff_campaign_codes').insert({
      campaign_id: camp.id,
      partner_id: partner.id,
      shopify_code: discountCode,
      shopify_discount_gid: 'legacy',   // Collabs 가 만든 코드 — 우리가 발급하지 않았다
      status: 'active',
    });
    if (cErr) {
      const dup = cErr.code === '23505';
      return res.status(dup ? 409 : 500).json({ error: dup ? '이미 다른 파트너에 묶인 할인코드' : cErr.message, partner });
    }
    legacyCode = discountCode;
  }

  return res.status(201).json({ ok: true, partner, legacyCode });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') return await handleGet(res);
    if (req.method === 'POST') {
      const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;
      if (body.action === 'add_partner') return await handleAddPartner(body, res);
      return res.status(400).json({ error: `unknown action: ${String(body.action)}` });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[affiliate-admin]', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
}
