/**
 * 어필리에이트 장부 — 공용 모듈 (Issue #178, 설계안 §5·§6)
 *
 * 여기 있는 함수는 주문 웹훅(api/shopify-purchase-webhook.ts)과 어드민 API 가 함께 쓴다.
 *
 * 원칙
 *  - 웹훅 갈래는 **어떤 경우에도 throw 하지 않는다.** 커미션 하나 놓치는 것보다
 *    GA4·LINE 알림이 멈추는 쪽이 훨씬 비싸다. 모든 실패는 `[Affiliate]` 로그로만 남긴다.
 *  - Shopify 를 다시 부르지 않는다. 판정에 필요한 값은 웹훅 페이로드와 우리 DB 에서만 읽는다
 *    (웹훅 5초 제한 — 초과가 쌓이면 Shopify 가 웹훅을 자동 삭제한다).
 *  - `AFFILIATE_ENABLED` 환경변수가 킬스위치다. 배포 없이 끌 수 있어야 한다.
 *  - **회원 한정(설계 §5, 2026-09-21 확정)** — 구매자가 회원(LINE 로그인 고객)일 때만 커미션이 생긴다.
 *    회원 판정은 «로그인했는가»가 아니라 «주문 고객이 line_id 표식을 가진 계정인가» — 체크아웃이 토큰
 *    무효 시 게스트로 재시도하는 폴백과 초기 가입자(UNIDENTIFIED_CUSTOMER)를 둘 다 흡수하기 위해서다.
 *    비회원 주문은 파트너를 알 수 있을 때(코드·카트 ref)만 status=nonmember·커미션 0 으로 남긴다 —
 *    회원 한정이 얼마를 걸렀는지 어드민에서 보기 위해.
 *
 * ⚠️ `api/` 안의 상대 import 는 반드시 `.js` 확장자 (2026-08-21 장애).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'crypto';

/** 기본 커미션 10% — 이용약관 第3条 1항. 우대는 전부 aff_campaigns 에 있다 */
export const BASE_RATE = 0.10;
/** 귀속 창 · 확정 대기 — 둘 다 30일 (약관 第3条 4항 · 第4条 1항) */
export const ATTRIBUTION_WINDOW_DAYS = 30;
export const CONFIRM_WAIT_DAYS = 30;

/** 수동 등록 파트너(어드민에서 추가, LINE 가입 전)의 line_user_id 접두어 */
export const MANUAL_LINE_ID_PREFIX = 'manual:';
/** Collabs 이행 코드를 묶는 시스템 캠페인 이름 */
export const LEGACY_CAMPAIGN_NAME = 'Collabs 이행 코드';

const PLACEHOLDER_EMAIL_DOMAIN = '@line-user.biteme.co.jp';

/** 파트너 코드 규격 — 대문자·숫자 4~12자 (어드민 등록 폼과 같은 규칙) */
export const CODE_RE = /^[A-Z0-9]{4,12}$/;
export function normalizeCode(raw: unknown): string | null {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return CODE_RE.test(code) ? code : null;
}

/**
 * LINE 로그인 세션 토큰 검증 — api/line-callback.ts 의 signSessionToken 과 같은 규약
 * (payload {u: lineUserId, c: shopifyCustomerId|null, e: 만료 ms}, HMAC-SHA256 base64url).
 * 🔴 클라이언트가 보낸 userId 는 절대 믿지 않는다 — 여기서 꺼낸 값만 쓴다.
 */
export function verifyLineSession(
  token: unknown,
  secret: string
): { lineUserId: string; shopifyCustomerId: string | null } | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.e !== 'number' || Date.now() > payload.e) return null;
    if (typeof payload?.u !== 'string' || !payload.u) return null;
    const c = typeof payload.c === 'string' && payload.c ? payload.c : null;
    return { lineUserId: payload.u, shopifyCustomerId: c };
  } catch {
    return null;
  }
}

export function isAffiliateEnabled(): boolean {
  const v = (process.env.AFFILIATE_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

let client: SupabaseClient | null = null;
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정');
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface AffPartner {
  id: number;
  code: string;
  line_user_id: string;
  shopify_customer_id: string | null;
  name: string;
  instagram: string | null;
  email: string | null;
  status: 'active' | 'suspended' | 'withdrawn';
  joined_at: string;
  terms_version?: string;
  invoice_reg_no?: string | null;
  withdrawn_at?: string | null;
}

export interface AffCampaign {
  id: number;
  name: string;
  starts_at: string;
  ends_at: string;
  commission_rate: number;
  discount_percent: number | null;
  scope: 'all' | 'partners' | 'products';
  target_ids: string[];
  active: boolean;
}

/** orders/create 웹훅(REST) 페이로드 중 귀속 판정에 쓰는 필드만 */
export interface OrderForAttribution {
  id: number;
  name?: string | null;
  order_number: number;
  created_at?: string | null;
  email?: string | null;
  /** REST 웹훅 페이로드의 customer.tags 는 쉼표 구분 문자열이다 (Admin GraphQL 이면 배열) */
  customer?: { id: number; email?: string | null; tags?: string | string[] | null } | null;
  current_subtotal_price?: string | null;
  subtotal_price?: string | null;
  discount_codes?: Array<{ code: string; amount?: string; type?: string }> | null;
  note_attributes?: Array<{ name: string; value: string }> | null;
  line_items?: Array<{ product_id?: number | null }> | null;
}

export type Attribution = 'code' | 'ref' | 'customer';

/** 웹훅이 LINE 알림용으로 이미 조회한 결과를 넘겨받는다 — 어필리에이트 갈래가 Shopify 를 다시 부르지 않기 위해 */
export interface RecordOptions {
  /** resolveLineTarget 이 찾은 LINE userId. null = 조회했지만 LINE 유저 아님, undefined = 조회 못 함(예외 등) */
  lineUserId?: string | null;
}

export interface ConversionDecision {
  partner: AffPartner;
  attribution: Attribution;
  campaignId: number | null;   // 코드 귀속일 때 그 코드의 캠페인
  clickId: number | null;
}

// ── 판정 ─────────────────────────────────────────────────────────────────────

/** 자리표시자 이메일의 로컬파트에 LINE userId 가 들어있다 (api/line-callback.ts 규약) */
function lineUserIdFromEmail(email: string | null | undefined): string | null {
  if (!email || !email.endsWith(PLACEHOLDER_EMAIL_DOMAIN)) return null;
  const local = email.slice(0, -PLACEHOLDER_EMAIL_DOMAIN.length);
  return local.startsWith('line_') ? local.slice('line_'.length) : null;
}

/**
 * 회원 주문인가 — 주문 고객이 LINE 연동 표식을 가진 계정인지.
 * 순서: ① 웹훅이 Admin 으로 이미 확인한 lineUserId → ② 페이로드 customer.tags 의 `line_id:` →
 * ③ 자리표시자 이메일. Admin 조회가 실패해도(undefined) ②③으로 판정할 수 있어 조용히 비회원으로
 * 떨어지는 일이 줄어든다. 셋 다 없으면 비회원.
 */
export function memberLineUserId(order: OrderForAttribution, lineUserId?: string | null): string | null {
  if (lineUserId) return lineUserId;
  const rawTags = order.customer?.tags;
  const tags = Array.isArray(rawTags) ? rawTags : (rawTags ?? '').split(',');
  const tag = tags.map((t) => t.trim()).find((t) => t.startsWith('line_id:'));
  if (tag && tag.length > 'line_id:'.length) return tag.slice('line_id:'.length);
  return lineUserIdFromEmail(order.email ?? order.customer?.email ?? null);
}

/**
 * 회원 판정 4번째 근거 — 카트 속성 aff_ref 의 clickId 가 「로그인 상태의 클릭」(aff_touches.click_id) 이면 그 LINE 회원.
 * 왜: 주문의 고객 레코드가 LINE 연동 계정이 아닐 수 있다 — Storefront 토큰이 안 나오는 초기 가입자, Shop Pay 로 만들어진
 *     별도 계정, 체크아웃 게스트 폴백(2026-09-21 소프트 오픈 #3728 실측: LINE 계정과 Shop 계정이 따로 있어 비회원으로 떨어짐).
 *     카트 속성은 클릭한 그 브라우저에서 나온 것이므로, 그 클릭이 회원의 것이었으면 구매자도 그 회원이다.
 */
export async function memberLineUserIdByClick(sb: SupabaseClient, order: OrderForAttribution): Promise<string | null> {
  const ref = attr(order, 'aff_ref');
  if (!ref) return null;
  const clickRaw = ref.split(':')[1];
  if (!clickRaw || !/^\d+$/.test(clickRaw)) return null;
  const { data, error } = await sb.from('aff_touches').select('line_user_id').eq('click_id', Number(clickRaw)).maybeSingle();
  if (error) throw new Error(`aff_touches(click) 조회 실패: ${error.message}`);
  return (data as { line_user_id: string } | null)?.line_user_id ?? null;
}

export function isMemberOrder(order: OrderForAttribution, lineUserId?: string | null): boolean {
  return memberLineUserId(order, lineUserId) !== null;
}

/** 파트너 본인·가입 응답에 내보내는 공개 필드 — 내부 id·LINE id 는 내보내지 않는다 */
export function publicPartner(p: AffPartner) {
  return {
    code: p.code,
    link: `https://biteme.co.jp/a/${p.code}`,
    status: p.status,
    joinedAt: p.joined_at,
    instagram: p.instagram,
    invoiceRegNo: p.invoice_reg_no ?? null,
    termsVersion: p.terms_version ?? null,
  };
}

// ── 터치 ─────────────────────────────────────────────────────────────────────

export interface TouchInput {
  lineUserId: string;
  partnerId: number;
  /** 클릭 시각. 로그인 승격이면 localStorage 에 있던 원래 클릭 시각 — 30일 창은 클릭 기준이다 */
  touchedAt: Date;
  source: 'link' | 'login';
  clickId?: number | null;
  shopifyCustomerId?: string | null;
}

/**
 * 회원의 마지막 터치를 남긴다 (설계 §5 주 경로). line_user_id 당 한 행 — 더 최근 터치만 덮어쓴다.
 * 로그인 승격이 옛 클릭 시각을 들고 와도 이미 있는 더 새 터치를 지우지 않기 위해 읽고 쓴다.
 */
export async function recordTouch(sb: SupabaseClient, t: TouchInput): Promise<'inserted' | 'updated' | 'kept'> {
  const { data: existing, error: readErr } = await sb
    .from('aff_touches')
    .select('touched_at')
    .eq('line_user_id', t.lineUserId)
    .maybeSingle();
  if (readErr) throw new Error(`aff_touches 조회 실패: ${readErr.message}`);
  if (existing && new Date((existing as { touched_at: string }).touched_at).getTime() >= t.touchedAt.getTime()) return 'kept';

  const row = {
    line_user_id: t.lineUserId,
    partner_id: t.partnerId,
    touched_at: t.touchedAt.toISOString(),
    source: t.source,
    click_id: t.clickId ?? null,
    shopify_customer_id: t.shopifyCustomerId ?? null,
  };
  const { error } = await sb.from('aff_touches').upsert(row, { onConflict: 'line_user_id' });
  if (error) throw new Error(`aff_touches 저장 실패: ${error.message}`);
  return existing ? 'updated' : 'inserted';
}

/** 활동 중인 파트너를 코드로 찾는다. 정지·탈퇴 파트너의 링크는 죽은 링크다(약관 第12条) */
export async function findActivePartner(sb: SupabaseClient, code: string): Promise<AffPartner | null> {
  const { data, error } = await sb.from('aff_partners').select('*').eq('code', code).eq('status', 'active').maybeSingle();
  if (error) throw new Error(`aff_partners 조회 실패: ${error.message}`);
  return (data as AffPartner | null) ?? null;
}

/** 귀속 기준액 = current_subtotal_price (2026-09-17 실측: 세 0·배송 별도·할인 후 상품 소계). 엔 정수 */
export function eligibleAmountOf(order: OrderForAttribution): number {
  const raw = order.current_subtotal_price ?? order.subtotal_price ?? '0';
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function attr(order: OrderForAttribution, name: string): string | undefined {
  return order.note_attributes?.find((a) => a.name === name)?.value?.trim() || undefined;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * 세 갈래 귀속 판정 (설계 §5 흐름도). 순서가 우선순위다.
 *  1) 주문의 할인코드가 캠페인 전용 코드(aff_campaign_codes)면 → code
 *  2) 카트 속성 aff_ref(=파트너 코드) 가 30일 창 안이면 → ref
 *  3) 이 고객이 30일 안에 누군가의 링크를 눌렀으면(aff_touches) → customer
 * 셋 다 아니면 null — 자연 유입이다.
 */
export async function decideAttribution(
  sb: SupabaseClient,
  order: OrderForAttribution,
  orderedAt: Date,
  opts: { memberLineUserId: string | null } = { memberLineUserId: null }
): Promise<ConversionDecision | null> {
  // 1) 코드
  const codes = (order.discount_codes ?? []).map((d) => d.code.toUpperCase()).filter(Boolean);
  if (codes.length > 0) {
    const { data, error } = await sb
      .from('aff_campaign_codes')
      .select('campaign_id, partner_id, status, partner:aff_partners(*)')
      .in('shopify_code', codes)
      .limit(1);
    if (error) throw new Error(`aff_campaign_codes 조회 실패: ${error.message}`);
    const row = data?.[0] as { campaign_id: number; partner_id: number; status: string; partner: AffPartner | AffPartner[] } | undefined;
    if (row) {
      const partner = Array.isArray(row.partner) ? row.partner[0] : row.partner;
      if (partner) return { partner, attribution: 'code', campaignId: row.campaign_id, clickId: null };
    }
  }

  // 2) 링크 (카트 속성). 값 형식: "CODE" 또는 "CODE:clickId". aff_ref_at 이 있으면 30일 창을 서버에서도 확인
  const ref = attr(order, 'aff_ref');
  if (ref) {
    const [codeRaw, clickRaw] = ref.split(':');
    const code = (codeRaw || '').toUpperCase();
    const refAt = attr(order, 'aff_ref_at');
    const withinWindow = !refAt || daysBetween(new Date(refAt), orderedAt) <= ATTRIBUTION_WINDOW_DAYS;
    if (code && withinWindow) {
      const { data, error } = await sb.from('aff_partners').select('*').eq('code', code).maybeSingle();
      if (error) throw new Error(`aff_partners 조회 실패: ${error.message}`);
      if (data) {
        const clickId = clickRaw && /^\d+$/.test(clickRaw) ? Number(clickRaw) : null;
        return { partner: data as AffPartner, attribution: 'ref', campaignId: null, clickId };
      }
    }
  }

  // 3) 회원의 서버측 터치 — 회원 한정의 주 경로. 키는 LINE userId (기기·브라우저 무관).
  //    비회원은 터치가 있을 수 없으니 건너뛴다
  if (opts.memberLineUserId) {
    const since = new Date(orderedAt.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000).toISOString();
    const { data, error } = await sb
      .from('aff_touches')
      .select('partner_id, touched_at, click_id, partner:aff_partners(*)')
      .eq('line_user_id', opts.memberLineUserId)
      .gte('touched_at', since)
      .maybeSingle();
    if (error) throw new Error(`aff_touches 조회 실패: ${error.message}`);
    const row = data as { click_id: number | null; partner: AffPartner | AffPartner[] } | null;
    const partner = row ? (Array.isArray(row.partner) ? row.partner[0] : row.partner) : null;
    if (partner) return { partner, attribution: 'customer', campaignId: null, clickId: row?.click_id ?? null };
  }

  return null;
}

/**
 * 요율 해석 — ① 적용 중인 캠페인(여럿이면 가장 높은 요율) → ② 기본 10%.
 * 값은 주문 시점에 aff_conversions.rate 에 박아 두고 이후 변경에 소급하지 않는다.
 */
export async function resolveRate(
  sb: SupabaseClient,
  partnerId: number,
  productIds: number[],
  orderedAt: Date,
  preferredCampaignId: number | null
): Promise<{ rate: number; rateSource: string; campaignId: number | null }> {
  const at = orderedAt.toISOString();
  const { data, error } = await sb
    .from('aff_campaigns')
    .select('*')
    .eq('active', true)
    .lte('starts_at', at)
    .gte('ends_at', at);
  if (error) throw new Error(`aff_campaigns 조회 실패: ${error.message}`);

  const productGids = new Set(productIds.flatMap((id) => [String(id), `gid://shopify/Product/${id}`]));
  const applicable = ((data ?? []) as AffCampaign[]).filter((c) => {
    if (c.scope === 'all') return true;
    if (c.scope === 'partners') return c.target_ids.includes(String(partnerId));
    if (c.scope === 'products') return c.target_ids.some((t) => productGids.has(t));
    return false;
  });

  // 코드 귀속이면 그 코드의 캠페인이 우선 — 그 캠페인 기간이 끝났어도 코드는 그 조건으로 나간 것이다
  if (preferredCampaignId != null) {
    let preferred = applicable.find((c) => c.id === preferredCampaignId) ?? null;
    if (!preferred) {
      const { data: one } = await sb.from('aff_campaigns').select('*').eq('id', preferredCampaignId).maybeSingle();
      preferred = (one as AffCampaign | null) ?? null;
    }
    if (preferred) return { rate: Number(preferred.commission_rate), rateSource: `campaign:${preferred.id}`, campaignId: preferred.id };
  }

  if (applicable.length > 0) {
    const best = applicable.reduce((a, b) => (Number(b.commission_rate) > Number(a.commission_rate) ? b : a));
    return { rate: Number(best.commission_rate), rateSource: `campaign:${best.id}`, campaignId: best.id };
  }
  return { rate: BASE_RATE, rateSource: 'base', campaignId: null };
}

/** 자기 링크로 자기 구매 — 약관 第4条 3항. 결제는 막지 않고 커미션만 0 */
export function isSelfPurchase(partner: AffPartner, order: OrderForAttribution, memberLineId?: string | null): boolean {
  if (memberLineId && memberLineId === partner.line_user_id) return true;
  const customerId = order.customer?.id ? String(order.customer.id) : null;
  if (customerId && partner.shopify_customer_id && customerId === partner.shopify_customer_id) return true;

  const rawEmail = (order.email ?? order.customer?.email ?? '').trim();
  const email = rawEmail.toLowerCase();
  if (email && partner.email && email === partner.email.toLowerCase()) return true;

  // LINE userId 는 대소문자를 구분한다(U + 32 hex) — 소문자화 전의 원문에서 뽑는다
  const lineId = lineUserIdFromEmail(rawEmail);
  if (lineId && lineId === partner.line_user_id) return true;

  return false;
}

// ── 적재 ─────────────────────────────────────────────────────────────────────

export interface RecordResult {
  outcome: 'disabled' | 'unattributed' | 'inserted' | 'nonmember' | 'duplicate' | 'error';
  detail?: string;
}

/**
 * orders/create 한 건을 장부에 앉힌다. **절대 throw 하지 않는다.**
 * order_id 유니크 + ignoreDuplicates 로 웹훅 재전송에도 두 번 쌓이지 않는다.
 */
export async function recordConversionFromOrder(
  order: OrderForAttribution,
  options: RecordOptions = {}
): Promise<RecordResult> {
  if (!isAffiliateEnabled()) return { outcome: 'disabled' };

  try {
    const sb = getSupabase();
    const orderedAt = order.created_at ? new Date(order.created_at) : new Date();

    // 회원 게이트가 맨 앞이다 (설계 §5). 비회원이면 코드·카트 ref 로 파트너를 알 수 있을 때만 기록한다.
    const lineUserId = memberLineUserId(order, options.lineUserId) ?? (await memberLineUserIdByClick(sb, order));
    const member = lineUserId !== null;
    const decision = await decideAttribution(sb, order, orderedAt, { memberLineUserId: lineUserId });
    if (!decision) return { outcome: 'unattributed' };

    const { partner, attribution, clickId } = decision;
    const productIds = (order.line_items ?? []).map((l) => l.product_id).filter((v): v is number => typeof v === 'number');
    const { rate, rateSource, campaignId } = await resolveRate(sb, partner.id, productIds, orderedAt, decision.campaignId);

    const eligible = eligibleAmountOf(order);
    const self = isSelfPurchase(partner, order, lineUserId);
    // 정지·탈퇴한 파트너의 주문은 장부에는 남기되 커미션 0 (void) — 나중에 대조할 수 있게.
    // 비회원 주문도 같은 방식으로 nonmember·0 — 회원 한정이 거른 규모를 셀 수 있게.
    const inactive = partner.status !== 'active';
    const commission = !member || self || inactive ? 0 : Math.round(eligible * rate);
    const status = !member ? 'nonmember' : self ? 'self' : inactive ? 'void' : 'pending';
    const confirmAt = new Date(orderedAt.getTime() + CONFIRM_WAIT_DAYS * 86_400_000);

    const row = {
      order_id: String(order.id),
      order_name: order.name ?? `#${order.order_number}`,
      partner_id: partner.id,
      attribution,
      shopify_customer_id: order.customer?.id ? String(order.customer.id) : null,
      click_id: clickId,
      campaign_id: campaignId,
      eligible_amount: eligible,
      rate,
      rate_source: rateSource,
      commission,
      status,
      ordered_at: orderedAt.toISOString(),
      confirm_at: confirmAt.toISOString(),
      raw: {
        discount_codes: order.discount_codes ?? [],
        aff_ref: attr(order, 'aff_ref') ?? null,
        aff_ref_at: attr(order, 'aff_ref_at') ?? null,
        member,
        member_line_user_id: lineUserId,
        member_hint: options.lineUserId ? 'admin' : lineUserId && memberLineUserId(order, options.lineUserId) ? 'payload' : lineUserId ? 'click' : 'none',
        current_subtotal_price: order.current_subtotal_price ?? null,
        subtotal_price: order.subtotal_price ?? null,
      },
    };

    const { data, error } = await sb
      .from('aff_conversions')
      .upsert(row, { onConflict: 'order_id', ignoreDuplicates: true })
      .select('id');
    if (error) return { outcome: 'error', detail: error.message };

    const inserted = (data?.length ?? 0) > 0;
    console.log(
      `[Affiliate] ${inserted ? '적재' : '중복(무시)'} ${row.order_name} → ${partner.code} ` +
      `${attribution} ¥${eligible} × ${rate} = ¥${commission} (${status}) [${rateSource}]`
    );
    if (!inserted) return { outcome: 'duplicate' };
    return { outcome: member ? 'inserted' : 'nonmember' };
  } catch (err) {
    return { outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── 환불·취소·확정 (설계 §8 04·08, 약관 第4条) ──────────────────────────────

export interface AffConversionRow {
  id: number;
  order_id: string;
  order_name: string | null;
  partner_id: number;
  eligible_amount: number;
  rate: number;
  commission: number;
  status: 'pending' | 'confirmed' | 'reversed' | 'self' | 'void' | 'nonmember';
  confirm_at: string;
  payout_id: number | null;
}

/**
 * 주문의 (환불 반영 후) 기준액으로 장부 한 건을 다시 계산한다.
 *  - 기준액 0 또는 취소 → reversed (커미션 0)
 *  - 기준액이 줄었으면 커미션 재계산 (부분 환불 — 약관 第4条 2항)
 *  - self·void·nonmember 는 커미션이 애초에 0 이라 금액만 갱신
 * 이미 정산 묶음(payout_id)에 들어간 건은 상태를 바꾸되 금액은 Phase 3 회수 로직이 다룬다 — 여기서 덮어쓰지 않는다.
 * 돌려주는 값은 무엇을 했는지(로그·게이트용).
 */
export async function applyOrderAmount(
  sb: SupabaseClient,
  row: AffConversionRow,
  newEligible: number,
  cancelled: boolean,
  reason: string
): Promise<'reversed' | 'recalculated' | 'unchanged'> {
  const zeroCommission = row.status === 'self' || row.status === 'void' || row.status === 'nonmember';
  const eligible = Math.max(0, Math.round(newEligible));

  if (cancelled || eligible === 0) {
    if (row.status === 'reversed') return 'unchanged';
    const patch: Record<string, unknown> = {
      status: 'reversed',
      reversed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // 지급 전이면 금액도 0 으로. 지급 후면 금액은 남겨 Phase 3 회수 근거로 쓴다
    if (!row.payout_id) { patch.eligible_amount = eligible; patch.commission = 0; }
    const { error } = await sb.from('aff_conversions').update(patch).eq('id', row.id);
    if (error) throw new Error(`aff_conversions 회수 실패: ${error.message}`);
    console.log(`[Affiliate] 회수 ${row.order_name ?? row.order_id} (${reason}) ¥${row.commission} → 0`);
    return 'reversed';
  }

  if (eligible >= row.eligible_amount) return 'unchanged';
  if (row.payout_id) return 'unchanged'; // 지급 후 부분 환불은 Phase 3 에서
  const commission = zeroCommission ? 0 : Math.round(eligible * Number(row.rate));
  const { error } = await sb
    .from('aff_conversions')
    .update({ eligible_amount: eligible, commission, updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (error) throw new Error(`aff_conversions 재계산 실패: ${error.message}`);
  console.log(`[Affiliate] 부분 환불 ${row.order_name ?? row.order_id} (${reason}) ¥${row.eligible_amount}→¥${eligible} 커미션 ¥${row.commission}→¥${commission}`);
  return 'recalculated';
}

export async function findConversionByOrderId(sb: SupabaseClient, orderId: string | number): Promise<AffConversionRow | null> {
  const { data, error } = await sb.from('aff_conversions').select('*').eq('order_id', String(orderId)).maybeSingle();
  if (error) throw new Error(`aff_conversions 조회 실패: ${error.message}`);
  return (data as AffConversionRow | null) ?? null;
}

/** refunds/create 웹훅 페이로드 중 쓰는 것. refund_line_items[].subtotal = 할인 후 상품 소계(배송비 제외) */
export interface RefundPayload {
  id: number;
  order_id: number;
  refund_line_items?: Array<{ subtotal?: string | number | null; quantity?: number }> | null;
}

/** refunds/create — 환불된 상품 소계만큼 기준액을 줄인다. 배송비 환불은 커미션과 무관. 절대 throw 하지 않는다 */
export async function applyRefundWebhook(refund: RefundPayload): Promise<RecordResult> {
  if (!isAffiliateEnabled()) return { outcome: 'disabled' };
  try {
    const sb = getSupabase();
    const row = await findConversionByOrderId(sb, refund.order_id);
    if (!row) return { outcome: 'unattributed' };
    const refunded = (refund.refund_line_items ?? []).reduce((s, l) => s + (Number(l.subtotal ?? 0) || 0), 0);
    if (refunded <= 0) return { outcome: 'duplicate', detail: '상품 환불 없음(배송비 등)' };
    const r = await applyOrderAmount(sb, row, row.eligible_amount - refunded, false, `refund ${refund.id}`);
    return { outcome: r === 'unchanged' ? 'duplicate' : 'inserted', detail: r };
  } catch (err) {
    return { outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** orders/cancelled — 전액 회수. 절대 throw 하지 않는다 */
export async function applyCancelWebhook(order: { id: number; name?: string | null }): Promise<RecordResult> {
  if (!isAffiliateEnabled()) return { outcome: 'disabled' };
  try {
    const sb = getSupabase();
    const row = await findConversionByOrderId(sb, order.id);
    if (!row) return { outcome: 'unattributed' };
    const r = await applyOrderAmount(sb, row, 0, true, 'cancelled');
    return { outcome: r === 'unchanged' ? 'duplicate' : 'inserted', detail: r };
  } catch (err) {
    return { outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Admin GraphQL 주문 → 웹훅 모양 (크론 재대사·어드민 재판정 공용) ────────────

export interface AdminOrderNode {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  email: string | null;
  currentSubtotalPriceSet: { shopMoney: { amount: string } };
  discountCodes: string[];
  customAttributes: Array<{ key: string; value: string | null }>;
  customer: { id: string; email: string | null; tags: string[] } | null;
  lineItems: { nodes: Array<{ product: { id: string } | null }> };
}

export const ADMIN_ORDER_FIELDS = `
  id legacyResourceId name createdAt cancelledAt email
  currentSubtotalPriceSet { shopMoney { amount } }
  discountCodes
  customAttributes { key value }
  customer { id email tags }
  lineItems(first: 50) { nodes { product { id } } }
`;

const numericId = (gid: string): number => Number(String(gid).split('/').pop());

export function toOrderForAttribution(o: AdminOrderNode): OrderForAttribution {
  return {
    id: Number(o.legacyResourceId),
    name: o.name,
    order_number: Number(String(o.name).replace('#', '')) || 0,
    created_at: o.createdAt,
    email: o.email,
    customer: o.customer ? { id: numericId(o.customer.id), email: o.customer.email, tags: o.customer.tags } : null,
    current_subtotal_price: o.currentSubtotalPriceSet.shopMoney.amount,
    discount_codes: (o.discountCodes ?? []).map((code) => ({ code })),
    note_attributes: (o.customAttributes ?? []).map((a) => ({ name: a.key, value: a.value ?? '' })),
    line_items: (o.lineItems?.nodes ?? []).map((l) => ({ product_id: l.product ? numericId(l.product.id) : null })),
  };
}

/**
 * 어드민 「재판정」 — 장부의 한 건을 지우고 다시 판정한다. 판정 규칙이 바뀌었을 때 과거 주문을 바로잡는 용도.
 * 지급 묶음에 들어간 건(payout_id)은 건드리지 않는다.
 */
export async function reevaluateOrder(order: OrderForAttribution, options: RecordOptions = {}): Promise<RecordResult & { before: string | null }> {
  const sb = getSupabase();
  const existing = await findConversionByOrderId(sb, order.id);
  if (existing?.payout_id) return { outcome: 'error', detail: '정산 묶음에 들어간 주문은 재판정 불가', before: existing.status };
  if (existing) {
    const { error } = await sb.from('aff_conversions').delete().eq('id', existing.id);
    if (error) return { outcome: 'error', detail: error.message, before: existing.status };
  }
  const r = await recordConversionFromOrder(order, options);
  return { ...r, before: existing?.status ?? null };
}
