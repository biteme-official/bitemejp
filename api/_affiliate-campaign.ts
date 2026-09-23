/**
 * 어필리에이트 캠페인 — 생성·종료·전용 코드 발급·LINE 통지 (#178 Phase 3, 설계 §4 · 약관 第6条)
 *
 * 캠페인은 우대의 유일한 입구다. 저장이 끝이고 파트너 수락 단계는 없다.
 *  - 고객 할인율이 있는 캠페인은 「지정 파트너」 범위에서만 만든다. 그때 대상 파트너마다
 *    Shopify 전용 코드를 하나씩 만든다(discountCodeBasicCreate) — 1인 1회 + 총 사용 상한.
 *  - 종료하면 전용 코드를 Shopify 에서 비활성화하고 aff_campaign_codes 도 disabled.
 *    요율은 주문 시점에 장부에 박혀 있으므로 종료 전 발생분은 캠페인 요율 그대로다(第6条).
 *  - 대상 파트너에게 LINE 푸시로 조건(+코드)을 알린다. 실패해도 캠페인은 유효하다.
 *    야간(21~9시 JST)에 저장하면 notify_status='pending' 으로 두고 다음 날 09:05 크론이 보낸다.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SHOPIFY_API_VERSION } from './_shopify-api-version.js';
import { MANUAL_LINE_ID_PREFIX, type AffCampaign, type AffPartner } from './_affiliate.js';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';

/** 전용 코드 총 사용 상한 기본값 — 코드는 반드시 쿠폰 모음 사이트로 새므로 손해를 유한하게 (설계 §8 03) */
export const DEFAULT_USAGE_LIMIT = 100;

export async function getAdminToken(): Promise<string> {
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('REPORT_SHOPIFY 미설정');
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const token = (await res.json().catch(() => ({}))).access_token as string | undefined;
  if (!token) throw new Error(`Admin 토큰 실패 (${res.status})`);
  return token;
}

async function adminGraphQL<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data as T;
}

// ── 입력 검증 ────────────────────────────────────────────────────────────────

export interface CampaignInput {
  name: string;
  startsAt: string;
  endsAt: string;
  commissionRate: number;        // 0.15
  discountPercent: number | null; // 10 (지정 파트너 범위에서만)
  scope: AffCampaign['scope'];
  targetIds: string[];            // partners → aff_partners.id, products → 상품 URL·핸들·숫자 id (저장 전에 gid 로 바꾼다)
  usageLimit: number;
  notify: boolean;
}

/** 어드민 폼 값을 검증해 CampaignInput 으로. 문제가 있으면 한국어 오류 문자열 */
export function parseCampaignInput(body: Record<string, unknown>): CampaignInput | string {
  const name = String(body.name ?? '').trim();
  const startsAt = new Date(String(body.startsAt ?? ''));
  const endsAt = new Date(String(body.endsAt ?? ''));
  const commissionRate = Number(body.commissionRate);
  const discountRaw = body.discountPercent;
  const discountPercent = discountRaw === null || discountRaw === undefined || discountRaw === '' ? null : Number(discountRaw);
  const scope = String(body.scope ?? '') as AffCampaign['scope'];
  const targetIds = Array.isArray(body.targetIds) ? body.targetIds.map((t) => String(t).trim()).filter(Boolean) : [];
  const usageLimit = body.usageLimit === undefined || body.usageLimit === '' ? DEFAULT_USAGE_LIMIT : Number(body.usageLimit);

  if (!name) return '캠페인 이름은 필수';
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return '기간(시작·종료)이 날짜가 아님';
  if (endsAt <= startsAt) return '종료가 시작보다 늦어야 함';
  if (endsAt.getTime() <= Date.now()) return '이미 끝난 기간';
  if (!(commissionRate > 0 && commissionRate < 1)) return '커미션율은 0~100% 사이';
  if (discountPercent !== null && !(discountPercent > 0 && discountPercent <= 50)) return '고객 할인율은 1~50%';
  if (!['all', 'partners', 'products'].includes(scope)) return '대상은 전원·지정 파트너·지정 상품 중 하나';
  if (scope !== 'all' && targetIds.length === 0) return scope === 'partners' ? '파트너를 한 명 이상 고를 것' : '상품 URL 을 하나 이상 넣을 것';
  // 할인은 지정 파트너 캠페인에만 — 전원·상품 캠페인에 할인을 붙이면 전원이 코드를 받아 「할인 자판기」가 된다 (설계 §4)
  if (discountPercent !== null && scope !== 'partners') return '고객 할인은 「지정 파트너」 캠페인에만 붙일 수 있음';
  if (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 10000) return '코드 사용 상한은 1~10,000';

  return {
    name,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    commissionRate: Math.round(commissionRate * 10000) / 10000,
    discountPercent,
    scope,
    targetIds,
    usageLimit,
    notify: body.notify !== false,
  };
}

// ── Shopify 전용 코드 ───────────────────────────────────────────────────────

interface UserError { field?: string[] | null; message: string; code?: string | null }

/** 파트너 코드 + 할인율로 읽히는 코드 — 76D436-10OFF. 겹치면 캠페인 id 를 붙인다 */
export function campaignCodeFor(partnerCode: string, discountPercent: number, campaignId: number, taken: boolean): string {
  const base = `${partnerCode}-${Math.round(discountPercent)}OFF`;
  return taken ? `${base}-${campaignId}` : base;
}

async function createShopifyCode(
  token: string,
  args: { title: string; code: string; percent: number; startsAt: string; endsAt: string; usageLimit: number }
): Promise<{ gid: string } | { error: string; taken: boolean }> {
  const data = await adminGraphQL<{
    discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: UserError[] };
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
        title: args.title,
        code: args.code,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        context: { all: 'ALL' },
        customerGets: { value: { percentage: args.percent / 100 }, items: { all: true } },
        appliesOncePerCustomer: true,
        usageLimit: args.usageLimit,
        // 웰컴·증정 코드와 겹치지 않게 — 주문 할인끼리는 합산하지 않는다. 배송 할인과는 합산 허용
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
      },
    }
  );
  const r = data.discountCodeBasicCreate;
  if (r.codeDiscountNode) return { gid: r.codeDiscountNode.id };
  const msg = r.userErrors.map((e) => e.message).join(' / ') || '알 수 없는 오류';
  const taken = r.userErrors.some((e) => e.code === 'TAKEN' || /taken|already|使用|既に/i.test(e.message));
  return { error: msg, taken };
}

async function deactivateShopifyCode(token: string, gid: string): Promise<string | null> {
  const data = await adminGraphQL<{ discountCodeDeactivate: { userErrors: UserError[] } }>(
    token,
    `mutation($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message } } }`,
    { id: gid }
  );
  const errs = data.discountCodeDeactivate.userErrors;
  return errs.length ? errs.map((e) => e.message).join(' / ') : null;
}

/**
 * 상품 지정 입력(상품 URL · 핸들 · 숫자 id · gid)을 Shopify 상품 gid 로.
 * 사이트 상품 URL 은 /product/<핸들> 이라 하영이 붙여넣는 건 대개 URL 이다.
 */
export async function resolveProductGids(token: string, inputs: string[]): Promise<{ gids: string[]; missing: string[] }> {
  const gids: string[] = [];
  const missing: string[] = [];
  for (const raw of inputs) {
    if (/^gid:\/\/shopify\/Product\/\d+$/.test(raw)) { gids.push(raw); continue; }
    if (/^\d+$/.test(raw)) { gids.push(`gid://shopify/Product/${raw}`); continue; }
    let handle = raw;
    const m = raw.match(/\/products?\/([^/?#]+)/);
    if (m) handle = m[1];
    try { handle = decodeURIComponent(handle); } catch { /* 그대로 */ }
    const data = await adminGraphQL<{ products: { nodes: Array<{ id: string }> } }>(
      token,
      `query($q: String!) { products(first: 1, query: $q) { nodes { id } } }`,
      { q: `handle:'${handle.replace(/'/g, "\\'")}'` }
    );
    const id = data.products.nodes[0]?.id;
    if (id) gids.push(id); else missing.push(raw);
  }
  return { gids: [...new Set(gids)], missing };
}

// ── LINE 통지 ───────────────────────────────────────────────────────────────

const pctText = (r: number) => `${Math.round(r * 1000) / 10}%`;
const jstDate = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/** 파트너에게 보내는 일본어 안내 — 조건·기간·코드만. 선택 이유 같은 설명은 넣지 않는다 */
export function campaignMessage(c: { name: string; starts_at: string; ends_at: string; commission_rate: number; discount_percent: number | null; scope: string }, code: string | null): string {
  const lines = [
    '【BITE ME アフィリエイト】特別キャンペーンのお知らせ',
    '',
    `「${c.name}」`,
    `期間：${jstDate(c.starts_at)}〜${jstDate(c.ends_at)}`,
    `成果報酬：${pctText(Number(c.commission_rate))}${c.scope === 'products' ? '（対象商品のみ）' : ''}`,
  ];
  if (code && c.discount_percent != null) {
    lines.push(`フォロワー専用クーポン：${code}（${c.discount_percent}%OFF・お一人様1回）`);
  }
  lines.push('', '詳細・リンクはパートナーページから', 'https://biteme.co.jp/partner');
  return lines.join('\n');
}

async function pushLine(lineUserId: string, text: string): Promise<'sent' | 'not-friend' | 'failed'> {
  const token = process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  if (!token || lineUserId.startsWith(MANUAL_LINE_ID_PREFIX)) return 'failed';
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
  });
  if (res.ok) return 'sent';
  if (res.status === 403) return 'not-friend';
  console.error('[affiliate-campaign] LINE push', res.status, (await res.text()).slice(0, 200));
  return 'failed';
}

/** 같은 문구를 여러 명에게 — LINE multicast(요청당 500명). 친구 아님은 LINE 이 조용히 건너뛴다 */
export async function multicastLine(lineUserIds: string[], text: string): Promise<{ sent: number; failed: number }> {
  const token = process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  const ids = lineUserIds.filter((id) => !id.startsWith(MANUAL_LINE_ID_PREFIX));
  if (!token) return { sent: 0, failed: ids.length };
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const res = await fetch('https://api.line.me/v2/bot/message/multicast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: chunk, messages: [{ type: 'text', text }] }),
    });
    if (res.ok) sent += chunk.length;
    else { failed += chunk.length; console.error('[affiliate-campaign] LINE multicast', res.status, (await res.text()).slice(0, 200)); }
  }
  return { sent, failed };
}

/**
 * 파트너의 살아 있는 전용 코드를 Shopify·장부 양쪽에서 끈다 — 정지·탈퇴·삭제 때 (약관 第12条: 즉시 링크·코드 무효).
 * 절대 throw 하지 않는다: 탈퇴 자체를 막으면 안 되므로 실패는 로그만.
 */
export async function disablePartnerCodes(sb: SupabaseClient, partnerId: number): Promise<number> {
  try {
    const { data } = await sb.from('aff_campaign_codes').select('id, shopify_discount_gid').eq('partner_id', partnerId).eq('status', 'active');
    const rows = (data ?? []) as Array<{ id: number; shopify_discount_gid: string }>;
    if (rows.length === 0) return 0;
    const shopifyRows = rows.filter((r) => r.shopify_discount_gid.startsWith('gid://'));
    if (shopifyRows.length > 0) {
      const token = await getAdminToken();
      for (const r of shopifyRows) {
        const err = await deactivateShopifyCode(token, r.shopify_discount_gid).catch((e) => (e instanceof Error ? e.message : '실패'));
        if (err) console.error('[affiliate-campaign] 코드 비활성 실패', partnerId, err);
      }
    }
    await sb.from('aff_campaign_codes').update({ status: 'disabled' }).in('id', rows.map((r) => r.id));
    return rows.length;
  } catch (e) {
    console.error('[affiliate-campaign] disablePartnerCodes', partnerId, e);
    return 0;
  }
}

/** LINE 을 보내지 않는 시간대 — 기존 LINE 자동 발송(api/line-campaign.ts QUIET_HOURS)과 같은 21~9시 JST */
export const QUIET_HOURS = { from: 21, to: 9 } as const;
export function inQuietHours(now = new Date()): boolean {
  const h = new Date(now.getTime() + 9 * 3600_000).getUTCHours();
  return h >= QUIET_HOURS.from || h < QUIET_HOURS.to;
}

export interface NotifyResult { sent: number; notFriend: number; failed: number }

/**
 * 캠페인 알림 발송 — 저장 직후(낮) 또는 다음 날 아침 크론(야간 보류분)이 부른다.
 * 받는 사람은 보내는 시점에 다시 계산한다: 할인 캠페인 = 살아 있는 전용 코드를 가진 활동 파트너,
 * 그 외 = 지정 파트너 또는 활동 파트너 전원. 끝나면 notify_status='sent'.
 */
export async function sendCampaignNotifications(sb: SupabaseClient, campaign: AffCampaign): Promise<NotifyResult> {
  const notified: NotifyResult = { sent: 0, notFriend: 0, failed: 0 };
  let q = sb.from('aff_partners').select('*').eq('status', 'active');
  if (campaign.scope === 'partners') q = q.in('id', campaign.target_ids.map(Number));
  const { data } = await q;
  const partners = (data ?? []) as AffPartner[];

  if (campaign.discount_percent == null) {
    // 코드가 없으면 모두 같은 문구 — 한 번에 보낸다(전원 캠페인이 수백 명이어도 함수 시간 안에)
    const r = await multicastLine(partners.map((p) => p.line_user_id), campaignMessage(campaign, null));
    notified.sent = r.sent;
    notified.failed = r.failed;
  } else {
    const { data: codeRows } = await sb.from('aff_campaign_codes').select('partner_id, shopify_code').eq('campaign_id', campaign.id).eq('status', 'active');
    const codeByPartner = new Map(((codeRows ?? []) as Array<{ partner_id: number; shopify_code: string }>).map((c) => [c.partner_id, c.shopify_code]));
    for (const p of partners) {
      // 코드를 못 받은 사람에게는 보내지 않는다 — 코드 없는 할인 안내가 되므로
      const code = codeByPartner.get(p.id);
      if (!code) continue;
      const r = await pushLine(p.line_user_id, campaignMessage(campaign, code));
      if (r === 'sent') notified.sent += 1;
      else if (r === 'not-friend') notified.notFriend += 1;
      else notified.failed += 1;
    }
  }
  await sb.from('aff_campaigns').update({ notify_status: 'sent', notified_at: new Date().toISOString() }).eq('id', campaign.id);
  return notified;
}

/** 야간 보류분 발송 — 크론(09:05 JST)이 부른다. 이미 끝난 캠페인은 보내지 않고 접는다 */
export async function flushPendingCampaignNotifications(sb: SupabaseClient): Promise<{ campaigns: number; sent: number; skipped: number }> {
  const { data, error } = await sb.from('aff_campaigns').select('*').eq('notify_status', 'pending');
  if (error) throw new Error(error.message);
  let sent = 0;
  let skipped = 0;
  const rows = (data ?? []) as AffCampaign[];
  for (const c of rows) {
    if (!c.active || new Date(c.ends_at).getTime() <= Date.now()) {
      await sb.from('aff_campaigns').update({ notify_status: 'none' }).eq('id', c.id);
      skipped += 1;
      continue;
    }
    const r = await sendCampaignNotifications(sb, c);
    sent += r.sent;
  }
  return { campaigns: rows.length, sent, skipped };
}

// ── 생성 · 종료 ─────────────────────────────────────────────────────────────

export interface CreateResult {
  campaign: AffCampaign;
  codes: Array<{ partnerCode: string; code: string }>;
  codeErrors: Array<{ partnerCode: string; error: string }>;
  notified: NotifyResult;
  /** 야간이라 보류 — 다음 날 09:05 에 간다 */
  notifyPending: boolean;
}

export async function createCampaign(sb: SupabaseClient, input: CampaignInput, createdBy = 'admin'): Promise<CreateResult | string> {
  // 대상 파트너 — 지정이면 그 사람들(활동 중만), 전원·상품이면 활동 중 전원(통지 대상)
  let partnersQ = sb.from('aff_partners').select('*').eq('status', 'active');
  if (input.scope === 'partners') partnersQ = partnersQ.in('id', input.targetIds.map(Number));
  const { data: partnerRows, error: pErr } = await partnersQ;
  if (pErr) return pErr.message;
  const partners = (partnerRows ?? []) as AffPartner[];
  if (input.scope === 'partners' && partners.length === 0) return '고른 파트너가 모두 정지·탈퇴 상태';

  let token: string | null = null;
  let targetIds = input.targetIds;
  if (input.scope === 'products') {
    try { token = await getAdminToken(); } catch (e) { return e instanceof Error ? e.message : 'Admin 토큰 실패'; }
    const { gids, missing } = await resolveProductGids(token, input.targetIds);
    if (missing.length > 0) return `상품을 찾지 못함: ${missing.join(', ')}`;
    targetIds = gids;
  }

  const { data: created, error: cErr } = await sb
    .from('aff_campaigns')
    .insert({
      name: input.name,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      commission_rate: input.commissionRate,
      discount_percent: input.discountPercent,
      scope: input.scope,
      notify_status: input.notify ? 'pending' : 'none',
      // 지정 파트너는 실제로 활동 중인 사람만 남긴다
      target_ids: input.scope === 'partners' ? partners.map((p) => String(p.id)) : targetIds,
      active: true,
      created_by: createdBy,
    })
    .select('*')
    .single();
  if (cErr || !created) return cErr?.message ?? '캠페인 저장 실패';
  const campaign = created as AffCampaign;

  const codes: CreateResult['codes'] = [];
  const codeErrors: CreateResult['codeErrors'] = [];

  if (input.discountPercent !== null) {
    try { token ??= await getAdminToken(); }
    catch (e) {
      // 코드를 못 만들면 할인 캠페인은 반쪽이다 — 캠페인을 되돌리고 오류를 돌려준다
      await sb.from('aff_campaigns').delete().eq('id', campaign.id);
      return e instanceof Error ? e.message : 'Admin 토큰 실패';
    }
    for (const p of partners) {
      let code = campaignCodeFor(p.code, input.discountPercent, campaign.id, false);
      let r = await createShopifyCode(token as string, {
        title: `[Affiliate] ${input.name} · ${p.code}`, code, percent: input.discountPercent,
        startsAt: input.startsAt, endsAt: input.endsAt, usageLimit: input.usageLimit,
      });
      if ('error' in r && r.taken) {
        code = campaignCodeFor(p.code, input.discountPercent, campaign.id, true);
        r = await createShopifyCode(token as string, {
          title: `[Affiliate] ${input.name} · ${p.code}`, code, percent: input.discountPercent,
          startsAt: input.startsAt, endsAt: input.endsAt, usageLimit: input.usageLimit,
        });
      }
      if ('error' in r) { codeErrors.push({ partnerCode: p.code, error: r.error }); continue; }
      const { error } = await sb.from('aff_campaign_codes').insert({
        campaign_id: campaign.id, partner_id: p.id, shopify_code: code.toUpperCase(), shopify_discount_gid: r.gid, status: 'active',
      });
      if (error) {
        // 장부에 못 남긴 코드는 귀속이 안 된다 — Shopify 쪽도 바로 끈다
        await deactivateShopifyCode(token as string, r.gid).catch(() => null);
        codeErrors.push({ partnerCode: p.code, error: error.message });
        continue;
      }
      codes.push({ partnerCode: p.code, code: code.toUpperCase() });
    }
    if (codes.length === 0) {
      await sb.from('aff_campaigns').delete().eq('id', campaign.id);
      return `전용 코드를 하나도 만들지 못함 — ${codeErrors.map((e) => e.error).join(' / ')}`;
    }
  }

  let notified: NotifyResult = { sent: 0, notFriend: 0, failed: 0 };
  const notifyPending = input.notify && inQuietHours();
  if (input.notify && !notifyPending) notified = await sendCampaignNotifications(sb, campaign);

  return { campaign, codes, codeErrors, notified, notifyPending };
}

/** 종료 — active=false, 종료 시각을 지금으로 당기고, 전용 코드를 Shopify·장부 양쪽에서 끈다 */
export async function endCampaign(sb: SupabaseClient, campaignId: number): Promise<{ deactivated: number; errors: string[] } | string> {
  const { data: camp, error } = await sb.from('aff_campaigns').select('*').eq('id', campaignId).maybeSingle();
  if (error) return error.message;
  if (!camp) return '캠페인 없음';
  const c = camp as AffCampaign;

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { active: false };
  if (new Date(c.ends_at).getTime() > Date.now()) patch.ends_at = now > c.starts_at ? now : new Date(new Date(c.starts_at).getTime() + 1000).toISOString();
  const { error: uErr } = await sb.from('aff_campaigns').update(patch).eq('id', campaignId);
  if (uErr) return uErr.message;

  const { data: codeRows } = await sb.from('aff_campaign_codes').select('id, shopify_discount_gid').eq('campaign_id', campaignId).eq('status', 'active');
  const rows = (codeRows ?? []) as Array<{ id: number; shopify_discount_gid: string }>;
  const errors: string[] = [];
  let deactivated = 0;
  const shopifyRows = rows.filter((r) => r.shopify_discount_gid.startsWith('gid://'));
  if (shopifyRows.length > 0) {
    const token = await getAdminToken();
    for (const r of shopifyRows) {
      const err = await deactivateShopifyCode(token, r.shopify_discount_gid).catch((e) => (e instanceof Error ? e.message : '실패'));
      if (err) errors.push(err);
    }
  }
  // 'legacy'(Collabs 코드)는 우리가 끌 수 없다 — 장부 쪽만 끈다
  if (rows.length > 0) {
    const { error: dErr } = await sb.from('aff_campaign_codes').update({ status: 'disabled' }).in('id', rows.map((r) => r.id));
    if (dErr) errors.push(dErr.message);
    else deactivated = rows.length;
  }
  return { deactivated, errors };
}

/**
 * 삭제 — 잘못 만든 캠페인 정리용. 장부에 그 캠페인이 걸린 주문이 한 건이라도 있으면 거절(종료를 쓸 것).
 * 전용 코드는 Shopify 에서도 지운다. 코드·행은 FK cascade 로 함께 사라진다.
 */
export async function deleteCampaign(sb: SupabaseClient, campaignId: number): Promise<{ deletedCodes: number } | string> {
  const { data: camp, error } = await sb.from('aff_campaigns').select('id, created_by').eq('id', campaignId).maybeSingle();
  if (error) return error.message;
  if (!camp) return '캠페인 없음';
  if ((camp as { created_by: string | null }).created_by === 'system') return '시스템 캠페인은 지울 수 없음';

  const { count, error: cErr } = await sb.from('aff_conversions').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
  if (cErr) return cErr.message;
  if ((count ?? 0) > 0) return `이 캠페인이 적용된 주문이 ${count}건 있어 삭제 불가 — 종료로 처리할 것`;

  const { data: codeRows } = await sb.from('aff_campaign_codes').select('shopify_discount_gid').eq('campaign_id', campaignId);
  const gids = ((codeRows ?? []) as Array<{ shopify_discount_gid: string }>).map((r) => r.shopify_discount_gid).filter((g) => g.startsWith('gid://'));
  if (gids.length > 0) {
    const token = await getAdminToken();
    for (const id of gids) {
      const data = await adminGraphQL<{ discountCodeDelete: { userErrors: UserError[] } }>(
        token,
        `mutation($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message } } }`,
        { id }
      );
      const errs = data.discountCodeDelete.userErrors;
      if (errs.length) return `Shopify 코드 삭제 실패: ${errs.map((e) => e.message).join(' / ')}`;
    }
  }
  const { error: dErr } = await sb.from('aff_campaigns').delete().eq('id', campaignId);
  if (dErr) return dErr.message;
  return { deletedCodes: gids.length };
}
