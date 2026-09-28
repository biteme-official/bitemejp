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
import { MANUAL_LINE_ID_PREFIX, campaignPartnerIds, campaignProductGids, type AffCampaign, type AffPartner } from './_affiliate.js';

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
  /** 고객 할인이 붙는 상품 — 지정 파트너 + 할인 캠페인에서 필수. 상품 URL·핸들·숫자 id (저장 전에 gid 로) */
  discountProducts: string[];
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
  const discountProducts = Array.isArray(body.discountProducts) ? body.discountProducts.map((t) => String(t).trim()).filter(Boolean) : [];
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
  // 할인은 지정 상품에만 (하영 결정 9/28) — 링크 방문자에게 자동 적용되므로 범위를 좁혀 둔다
  if (discountPercent !== null && discountProducts.length === 0) return '할인 상품 URL 을 하나 이상 넣을 것';
  if (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 10000) return '코드 사용 상한은 1~10,000';

  return {
    name,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    commissionRate: Math.round(commissionRate * 10000) / 10000,
    discountPercent,
    scope,
    targetIds,
    discountProducts: discountPercent === null ? [] : discountProducts,
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
  args: { title: string; code: string; percent: number; startsAt: string; endsAt: string; usageLimit: number; productGids: string[] }
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
        customerGets: {
          value: { percentage: args.percent / 100 },
          items: args.productGids.length > 0 ? { products: { productsToAdd: args.productGids } } : { all: true },
        },
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

/** 이미 발급한 전용 코드의 조건을 캠페인 수정에 맞춘다. 코드 문자열(76D436-10OFF)은 그대로 — 파트너가 이미 퍼뜨렸다 */
async function updateShopifyCode(
  token: string,
  gid: string,
  args: { title: string; percent: number; startsAt: string; endsAt: string; usageLimit?: number; productsToAdd: string[]; productsToRemove: string[] }
): Promise<string | null> {
  const items = args.productsToAdd.length > 0 || args.productsToRemove.length > 0
    ? { items: { products: { productsToAdd: args.productsToAdd, productsToRemove: args.productsToRemove } } }
    : {};
  const data = await adminGraphQL<{ discountCodeBasicUpdate: { userErrors: UserError[] } }>(
    token,
    `mutation($id: ID!, $d: DiscountCodeBasicInput!) {
      discountCodeBasicUpdate(id: $id, basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } }
    }`,
    {
      id: gid,
      d: {
        title: args.title,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        ...(args.usageLimit !== undefined ? { usageLimit: args.usageLimit } : {}),
        customerGets: { value: { percentage: args.percent / 100 }, ...items },
      },
    }
  );
  const errs = data.discountCodeBasicUpdate.userErrors;
  return errs.length ? errs.map((e) => e.message).join(' / ') : null;
}

async function activateShopifyCode(token: string, gid: string): Promise<string | null> {
  const data = await adminGraphQL<{ discountCodeActivate: { userErrors: UserError[] } }>(
    token,
    `mutation($id: ID!) { discountCodeActivate(id: $id) { codeDiscountNode { id } userErrors { field message } } }`,
    { id: gid }
  );
  const errs = data.discountCodeActivate.userErrors;
  return errs.length ? errs.map((e) => e.message).join(' / ') : null;
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
    let handle = raw;
    const m = raw.match(/\/products?\/([^/?#]+)/);
    if (m) handle = m[1];
    try { handle = decodeURIComponent(handle); } catch { /* 그대로 */ }
    // 사이트 상품 URL 은 숫자 id(/product/10150719291705) — 핸들로 찾으면 없다. id 는 실제 있는 상품인지만 확인
    const idMatch = handle.match(/^(?:gid:\/\/shopify\/Product\/)?(\d+)$/);
    if (idMatch) {
      const gid = `gid://shopify/Product/${idMatch[1]}`;
      const found = await adminGraphQL<{ product: { id: string } | null }>(
        token,
        `query($id: ID!) { product(id: $id) { id } }`,
        { id: gid }
      );
      if (found.product?.id) gids.push(found.product.id); else missing.push(raw);
      continue;
    }
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
export function campaignMessage(c: { name: string; starts_at: string; ends_at: string; commission_rate: number; discount_percent: number | null; scope: string; target_ids?: string[] }, code: string | null): string {
  const lines = [
    '【BITE ME アフィリエイト】特別キャンペーンのお知らせ',
    '',
    `「${c.name}」`,
    `期間：${jstDate(c.starts_at)}〜${jstDate(c.ends_at)}`,
    `成果報酬：${pctText(Number(c.commission_rate))}${c.scope === 'products' ? '（対象商品のみ）' : ''}`,
  ];
  if (code && c.discount_percent != null) {
    const onlyProducts = c.scope === 'partners' && campaignProductGids(c as Pick<AffCampaign, 'target_ids'>).length > 0;
    lines.push(`フォロワー専用クーポン：${code}（${onlyProducts ? '対象商品' : ''}${c.discount_percent}%OFF・お一人様1回）`);
    // 링크로 들어온 LINE 회원은 코드 입력 없이 결제 때 자동 적용된다
    lines.push('※あなたのリンクから来たLINE会員は、コード入力なしで自動適用されます');
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
 * 어드민 화면은 별도 Vercel 프로젝트(bitemejp-admin)의 API 를 부르는데, 거기엔 LINE 발송 키가 없다(2026-09-23 실측).
 * 이 런타임에 키가 없으면 직접 보내지 않고, 키가 있는 본 사이트의 발송 크론(?task=notify)을 불러 보류분을 보내게 한다.
 */
export function canSendLineHere(): boolean {
  return !!process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
}

export interface RemoteFlushResult { ok: boolean; campaignsSent: number; noticesSent: number; error?: string }

export async function triggerRemoteNotify(): Promise<RemoteFlushResult> {
  const base = process.env.AFFILIATE_NOTIFY_BASE_URL || 'https://biteme.co.jp';
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return { ok: false, campaignsSent: 0, noticesSent: 0, error: 'ADMIN_SECRET 미설정' };
  try {
    const res = await fetch(`${base}/api/affiliate-cron?task=notify`, { headers: { Authorization: `Bearer ${secret}` } });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; campaigns?: { sent?: number }; notices?: { sent?: number } };
    if (!res.ok || !j.ok) return { ok: false, campaignsSent: 0, noticesSent: 0, error: `발송 서버 ${res.status}` };
    return { ok: true, campaignsSent: j.campaigns?.sent ?? 0, noticesSent: j.notices?.sent ?? 0 };
  } catch (e) {
    return { ok: false, campaignsSent: 0, noticesSent: 0, error: e instanceof Error ? e.message : '발송 서버 호출 실패' };
  }
}

/**
 * 캠페인 알림 발송 — 저장 직후(낮) 또는 다음 날 아침 크론(야간 보류분)이 부른다.
 * 받는 사람은 보내는 시점에 다시 계산한다: 할인 캠페인 = 살아 있는 전용 코드를 가진 활동 파트너,
 * 그 외 = 지정 파트너 또는 활동 파트너 전원. 끝나면 notify_status='sent'.
 */
export async function sendCampaignNotifications(sb: SupabaseClient, campaign: AffCampaign): Promise<NotifyResult> {
  const notified: NotifyResult = { sent: 0, notFriend: 0, failed: 0 };
  let q = sb.from('aff_partners').select('*').eq('status', 'active');
  if (campaign.scope === 'partners') q = q.in('id', campaignPartnerIds(campaign));
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
  // 한 명도 못 보냈고 실패만 있으면 'sent' 로 찍지 않는다 — 보류로 남겨 다음 아침 크론이 다시 보낸다
  if (notified.sent === 0 && notified.notFriend === 0 && notified.failed > 0) return notified;
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

/** 파트너별 Shopify 전용 코드 발급 + 장부 기록 — 생성·수정(파트너 추가) 공용 */
async function issuePartnerCodes(
  sb: SupabaseClient,
  token: string,
  campaignId: number,
  partners: AffPartner[],
  args: { name: string; percent: number; startsAt: string; endsAt: string; usageLimit: number; productGids: string[] }
): Promise<{ codes: CreateResult['codes']; codeErrors: CreateResult['codeErrors'] }> {
  const codes: CreateResult['codes'] = [];
  const codeErrors: CreateResult['codeErrors'] = [];
  for (const p of partners) {
    let code = campaignCodeFor(p.code, args.percent, campaignId, false);
    let r = await createShopifyCode(token, {
      title: `[Affiliate] ${args.name} · ${p.code}`, code, percent: args.percent,
      startsAt: args.startsAt, endsAt: args.endsAt, usageLimit: args.usageLimit, productGids: args.productGids,
    });
    if ('error' in r && r.taken) {
      code = campaignCodeFor(p.code, args.percent, campaignId, true);
      r = await createShopifyCode(token, {
        title: `[Affiliate] ${args.name} · ${p.code}`, code, percent: args.percent,
        startsAt: args.startsAt, endsAt: args.endsAt, usageLimit: args.usageLimit, productGids: args.productGids,
      });
    }
    if ('error' in r) { codeErrors.push({ partnerCode: p.code, error: r.error }); continue; }
    const { error } = await sb.from('aff_campaign_codes').insert({
      campaign_id: campaignId, partner_id: p.id, shopify_code: code.toUpperCase(), shopify_discount_gid: r.gid, status: 'active',
    });
    if (error) {
      // 장부에 못 남긴 코드는 귀속이 안 된다 — Shopify 쪽도 바로 끈다
      await deactivateShopifyCode(token, r.gid).catch(() => null);
      codeErrors.push({ partnerCode: p.code, error: error.message });
      continue;
    }
    codes.push({ partnerCode: p.code, code: code.toUpperCase() });
  }
  return { codes, codeErrors };
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
  let discountGids: string[] = [];
  if (input.discountProducts.length > 0) {
    try { token ??= await getAdminToken(); } catch (e) { return e instanceof Error ? e.message : 'Admin 토큰 실패'; }
    const { gids, missing } = await resolveProductGids(token, input.discountProducts);
    if (missing.length > 0) return `할인 상품을 찾지 못함: ${missing.join(', ')}`;
    discountGids = gids;
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
      // 할인 상품 gid 는 같은 배열에 — 파트너 id(숫자)와 섞여도 campaignPartnerIds/campaignProductGids 가 가른다
      target_ids: input.scope === 'partners' ? [...partners.map((p) => String(p.id)), ...discountGids] : targetIds,
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
    const issued = await issuePartnerCodes(sb, token as string, campaign.id, partners, {
      name: input.name, percent: input.discountPercent, startsAt: input.startsAt, endsAt: input.endsAt, usageLimit: input.usageLimit, productGids: discountGids,
    });
    codes.push(...issued.codes);
    codeErrors.push(...issued.codeErrors);
    if (codes.length === 0) {
      await sb.from('aff_campaigns').delete().eq('id', campaign.id);
      return `전용 코드를 하나도 만들지 못함 — ${codeErrors.map((e) => e.error).join(' / ')}`;
    }
  }

  let notified: NotifyResult = { sent: 0, notFriend: 0, failed: 0 };
  const notifyPending = input.notify && inQuietHours();
  if (input.notify && !notifyPending) {
    if (canSendLineHere()) {
      notified = await sendCampaignNotifications(sb, campaign);
    } else {
      // 어드민 프로젝트 — 본 사이트가 보류분(방금 저장한 이 캠페인)을 보낸다
      const r = await triggerRemoteNotify();
      notified = r.ok ? { sent: r.campaignsSent, notFriend: 0, failed: 0 } : { sent: 0, notFriend: 0, failed: 1 };
      if (!r.ok) console.error('[affiliate-campaign] 원격 발송 실패 — 내일 09:05 크론이 다시 보낸다', r.error);
    }
  }

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

export interface UpdateResult {
  campaign: AffCampaign;
  /** 새로 넣은 파트너에게 발급한 코드 */
  codes: CreateResult['codes'];
  /** 조건을 고친 기존 코드 수 */
  updatedCodes: number;
  /** 대상에서 뺀 파트너의 코드 — 비활성 */
  disabledCodes: number;
  codeErrors: CreateResult['codeErrors'];
}

/**
 * 수정 — 진행 중·예정 캠페인만. 대상 종류(전원·지정 파트너·지정 상품)와 할인 유무는 못 바꾼다(새로 만들 것).
 * 커미션율 변경은 이후 주문부터(이미 장부에 오른 주문은 그때 요율 그대로). LINE 알림은 다시 보내지 않는다.
 * 전용 코드: 남은 파트너 = Shopify 조건 갱신(코드 문자열은 그대로) · 뺀 파트너 = 비활성 · 넣은 파트너 = 새 발급.
 * body.usageLimit 이 비어 있으면 기존 코드의 사용 상한은 건드리지 않는다(상한은 Shopify 에만 있다).
 */
export async function updateCampaign(sb: SupabaseClient, campaignId: number, body: Record<string, unknown>): Promise<UpdateResult | string> {
  const { data: camp, error } = await sb.from('aff_campaigns').select('*').eq('id', campaignId).maybeSingle();
  if (error) return error.message;
  if (!camp) return '캠페인 없음';
  const before = camp as AffCampaign & { created_by: string | null };
  if (before.created_by === 'system') return '시스템 캠페인은 수정할 수 없음';
  if (!before.active || new Date(before.ends_at).getTime() <= Date.now()) return '끝난 캠페인은 수정할 수 없음';

  const hadDiscount = before.discount_percent != null;
  const wantsDiscount = !(body.discountPercent === null || body.discountPercent === undefined || body.discountPercent === '');
  if (hadDiscount !== wantsDiscount) return hadDiscount ? '할인은 뺄 수 없음 — 종료 후 새로 만들 것' : '할인은 나중에 붙일 수 없음 — 새로 만들 것';
  const keepUsageLimit = body.usageLimit === undefined || body.usageLimit === null || body.usageLimit === '';
  const input = parseCampaignInput({ ...body, scope: before.scope });
  if (typeof input === 'string') return input;

  let partners: AffPartner[] = [];
  if (input.scope === 'partners') {
    const { data: rows, error: pErr } = await sb.from('aff_partners').select('*').eq('status', 'active').in('id', input.targetIds.map(Number));
    if (pErr) return pErr.message;
    partners = (rows ?? []) as AffPartner[];
    if (partners.length === 0) return '고른 파트너가 모두 정지·탈퇴 상태';
  }

  let token: string | null = null;
  let productTargets: string[] = [];
  if (input.scope === 'products') {
    try { token = await getAdminToken(); } catch (e) { return e instanceof Error ? e.message : 'Admin 토큰 실패'; }
    const { gids, missing } = await resolveProductGids(token, input.targetIds);
    if (missing.length > 0) return `상품을 찾지 못함: ${missing.join(', ')}`;
    productTargets = gids;
  }
  let discountGids: string[] = [];
  if (input.discountPercent !== null) {
    try { token ??= await getAdminToken(); } catch (e) { return e instanceof Error ? e.message : 'Admin 토큰 실패'; }
    const { gids, missing } = await resolveProductGids(token, input.discountProducts);
    if (missing.length > 0) return `할인 상품을 찾지 못함: ${missing.join(', ')}`;
    discountGids = gids;
  }

  const { data: saved, error: uErr } = await sb
    .from('aff_campaigns')
    .update({
      name: input.name,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      commission_rate: input.commissionRate,
      discount_percent: input.discountPercent,
      target_ids: input.scope === 'partners' ? [...partners.map((p) => String(p.id)), ...discountGids] : input.scope === 'products' ? productTargets : [],
    })
    .eq('id', campaignId)
    .select('*')
    .single();
  if (uErr || !saved) return uErr?.message ?? '캠페인 저장 실패';
  const campaign = saved as AffCampaign;

  const result: UpdateResult = { campaign, codes: [], updatedCodes: 0, disabledCodes: 0, codeErrors: [] };
  if (input.discountPercent === null) return result;

  // 이 캠페인의 코드 전부(비활성 포함) — 뺐다가 다시 넣은 파트너는 새로 만들지 않고 옛 코드를 되살린다(같은 문자열이라 새로 못 만든다)
  const { data: codeRows } = await sb.from('aff_campaign_codes')
    .select('id, partner_id, shopify_code, shopify_discount_gid, status, partner:aff_partners(code)')
    .eq('campaign_id', campaignId);
  type CodeRow = { id: number; partner_id: number; shopify_code: string; shopify_discount_gid: string; status: string; partner: { code: string } | Array<{ code: string }> | null };
  const codes = ((codeRows ?? []) as unknown as CodeRow[]).filter((r) => r.shopify_discount_gid.startsWith('gid://')); // legacy(Collabs) 코드는 우리가 못 고친다
  const partnerCodeOf = (r: CodeRow) => (Array.isArray(r.partner) ? r.partner[0]?.code : r.partner?.code) ?? String(r.partner_id);
  const keepIds = new Set(partners.map((p) => p.id));
  const oldProducts = campaignProductGids(before);
  const productsToAdd = discountGids.filter((g) => !oldProducts.includes(g));
  const productsToRemove = oldProducts.filter((g) => !discountGids.includes(g));
  const tok = token as string;
  const fail = (r: CodeRow, e: unknown) => result.codeErrors.push({ partnerCode: partnerCodeOf(r), error: typeof e === 'string' ? e : e instanceof Error ? e.message : '실패' });

  // 뺀 파트너 — 살아 있는 코드를 끈다
  for (const r of codes.filter((c) => c.status === 'active' && !keepIds.has(c.partner_id))) {
    const err = await deactivateShopifyCode(tok, r.shopify_discount_gid).catch((e) => e);
    if (err) { fail(r, err); continue; }
    await sb.from('aff_campaign_codes').update({ status: 'disabled' }).eq('id', r.id);
    result.disabledCodes += 1;
  }

  // 남은·되돌아온 파트너 — 조건 갱신(되돌아온 사람은 먼저 되살림)
  const handled = new Set<number>();
  const byPartner = new Map<number, CodeRow>();
  for (const r of codes) {
    if (!keepIds.has(r.partner_id)) continue;
    const cur = byPartner.get(r.partner_id);
    if (!cur || (cur.status !== 'active' && r.status === 'active') || (cur.status === r.status && r.id > cur.id)) byPartner.set(r.partner_id, r);
  }
  for (const r of byPartner.values()) {
    handled.add(r.partner_id);
    if (r.status !== 'active') {
      const err = await activateShopifyCode(tok, r.shopify_discount_gid).catch((e) => e);
      if (err) { fail(r, err); continue; }
      await sb.from('aff_campaign_codes').update({ status: 'active' }).eq('id', r.id);
    }
    const err = await updateShopifyCode(tok, r.shopify_discount_gid, {
      title: `[Affiliate] ${input.name} · ${partnerCodeOf(r)}`,
      percent: input.discountPercent,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      // 비워 두면 기존 상한 유지 (되살린 코드도 예전 상한 그대로)
      ...(keepUsageLimit ? {} : { usageLimit: input.usageLimit }),
      productsToAdd,
      productsToRemove,
    }).catch((e) => e);
    if (err) fail(r, err);
    else if (r.status === 'active') result.updatedCodes += 1;
    else result.codes.push({ partnerCode: partnerCodeOf(r), code: r.shopify_code });
  }

  // 처음 넣은 파트너 — 새 발급
  const added = partners.filter((p) => !handled.has(p.id));
  if (added.length > 0) {
    const issued = await issuePartnerCodes(sb, tok, campaignId, added, {
      name: input.name, percent: input.discountPercent, startsAt: input.startsAt, endsAt: input.endsAt, usageLimit: input.usageLimit, productGids: discountGids,
    });
    result.codes.push(...issued.codes);
    result.codeErrors.push(...issued.codeErrors);
  }
  return result;
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
