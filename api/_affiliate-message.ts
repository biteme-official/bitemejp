/**
 * 어필리에이트 — 파트너에게 상황별 메시지 (Issue #270 → #272)
 *
 *  - 상황(가입 환영·첫 공유 유도·월간 리포트·정산 안내 …)마다 받는 사람 규칙과 다시 보내는 간격이 정해져 있다.
 *    정의는 `_affiliate-message-kinds.ts` 한 곳.
 *  - 미리 보기로 명단과 사람별 문구를 확인한 뒤 보낸다. 자동 발송은 없다 — 사람이 「보내기」를 눌러야 나간다(1차).
 *  - 보내기를 누른 순간 사람별 문구를 rendered 로 고정한다. 야간 보류분도 그 문구 그대로 나간다
 *    (단, 그새 정지·탈퇴한 사람은 뺀다).
 *  - 야간(21~9시 JST)이면 pending 으로 두고 다음 날 09:05 크론(?task=notify)이 보낸다 — 캠페인 알림·개정 통지와 같은 규칙.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { MANUAL_LINE_ID_PREFIX, fetchAllRows, type AffPartner } from './_affiliate.js';
import { canSendLineHere, inQuietHours, multicastLine, triggerRemoteNotify } from './_affiliate-campaign.js';
import { currentPeriodJst, dueDateOf, periodRange } from './_affiliate-payout.js';
import {
  KIND_DEFS,
  PARTNER_PAGE_URL,
  dateText,
  kindDef,
  monthText,
  renderBody,
  unknownVariables,
  yenText,
  type KindDef,
  type MessageKind,
} from './_affiliate-message-kinds.js';

/** 「클릭 0」을 보는 기간 */
export const MESSAGE_CLICK_WINDOW_DAYS = 30;
/** 서식 길이 상한 — LINE 텍스트 한 통은 5,000자지만 읽히는 길이로 막는다 */
export const MESSAGE_MAX_LENGTH = 1500;
/** 같은 문구 묶음을 동시에 보내는 수 */
const SEND_CONCURRENCY = 10;
const DAY = 86400_000;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MessageFilter {
  /** 최근 30일 클릭이 0인 사람만 */
  noClicks: boolean;
  /** 판매(확정 대기·확정)가 0건인 사람만 */
  noSales: boolean;
  /** 가입하고 이만큼 지난 사람만 (0 = 조건 없음) */
  joinedDaysMin: number;
  /** 최근 이만큼 안에 메시지(상황 무관)를 받은 사람은 뺀다 (0 = 빼지 않음) */
  skipMessagedDays: number;
}

/** 상황별 값 — aff_messages.filter 칸에 그대로 남는다 */
export interface MessageParams {
  filter?: MessageFilter;
  /** 월간 리포트의 대상 월 'YYYY-MM' */
  month?: string;
  /** 정산 안내의 정산 월 'YYYY-MM' */
  period?: string;
}

export interface AffMessage {
  id: number;
  kind: MessageKind;
  memo: string;
  body: string;
  filter: MessageParams;
  partner_ids: number[];
  rendered: Array<{ partner_id: number; text: string }>;
  notify_status: 'pending' | 'sent' | 'failed';
  sent_count: number;
  failed_count: number;
  notified_at: string | null;
  created_at: string;
}

const clampDays = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 0;
};

export function parseMessageFilter(raw: unknown): MessageFilter {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    noClicks: f.noClicks === true,
    noSales: f.noSales === true,
    joinedDaysMin: clampDays(f.joinedDaysMin),
    skipMessagedDays: clampDays(f.skipMessagedDays),
  };
}

/** JST 기준 지난달 'YYYY-MM' — 월간 리포트 기본값 */
export function previousPeriodJst(now = new Date()): string {
  const [y, m] = currentPeriodJst(now).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 상황에 맞는 값만 남긴다. 잘못된 값이면 문자열(에러) */
export function parseMessageParams(def: KindDef, raw: unknown, now = new Date()): MessageParams | string {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (def.param === 'filter') return { filter: parseMessageFilter(p.filter) };
  if (def.param === 'month') {
    const month = String(p.month ?? '') || previousPeriodJst(now);
    if (!PERIOD_RE.test(month)) return '대상 월은 YYYY-MM';
    if (month > currentPeriodJst(now)) return '대상 월이 미래입니다';
    return { month };
  }
  if (def.param === 'period') {
    const period = String(p.period ?? '');
    if (!PERIOD_RE.test(period)) return '정산 월(YYYY-MM)을 골라주세요';
    return { period };
  }
  return {};
}

export interface Recipient { id: number; code: string; name: string; instagram: string | null; joined_at: string }
export interface Target { partner: Recipient; vars: Record<string, string> }

type PartnerRow = Pick<AffPartner, 'id' | 'code' | 'name' | 'instagram' | 'joined_at' | 'line_user_id'>;
type ConversionRow = { partner_id: number; status: string; commission: number; ordered_at: string };
type HistoryRow = { partner_ids: number[]; created_at: string; filter: MessageParams | null; kind: string };

async function clickCounts(sb: SupabaseClient, start: string, end?: string): Promise<Map<number, number>> {
  const rows = await fetchAllRows<{ partner_id: number }>((from, to) => {
    let q = sb.from('aff_clicks').select('partner_id').eq('is_bot', false).gte('ts', start);
    if (end) q = q.lt('ts', end);
    return q.order('id').range(from, to);
  });
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.partner_id, (m.get(r.partner_id) ?? 0) + 1);
  return m;
}

/** 판매 = 확정 대기·확정. 취소·자기주문·비회원은 판매가 아니다 */
async function salesRows(sb: SupabaseClient): Promise<ConversionRow[]> {
  return fetchAllRows<ConversionRow>((from, to) => sb.from('aff_conversions').select('partner_id, status, commission, ordered_at').in('status', ['pending', 'confirmed']).order('id').range(from, to));
}

/** 보낸(또는 보낼) 기록 — 실패한 건 안 받았으니 빼지 않는다 */
async function history(sb: SupabaseClient, kind?: MessageKind): Promise<HistoryRow[]> {
  let q = sb.from('aff_messages').select('partner_ids, created_at, filter, kind').in('notify_status', ['pending', 'sent']);
  if (kind) q = q.eq('kind', kind);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as HistoryRow[];
}

const idsOf = (rows: HistoryRow[]) => new Set(rows.flatMap((r) => r.partner_ids.map(Number)));

/** 상황 규칙에 맞는 활동 파트너와 사람별 변수 — 미리 보기와 보내기가 같은 함수를 쓴다 */
export async function selectTargets(sb: SupabaseClient, def: KindDef, params: MessageParams, now = new Date()): Promise<Target[]> {
  const { data, error } = await sb.from('aff_partners').select('id, code, name, instagram, joined_at, line_user_id').eq('status', 'active');
  if (error) throw new Error(error.message);
  // 수동 등록 파트너는 LINE 이 없어 받을 수 없다
  let partners = ((data ?? []) as PartnerRow[]).filter((p) => !p.line_user_id.startsWith(MANUAL_LINE_ID_PREFIX));
  const joinedBefore = (days: number) => (p: PartnerRow) => new Date(p.joined_at).getTime() <= now.getTime() - days * DAY;
  const vars = new Map<number, Record<string, string>>();
  const setVars = (id: number, v: Record<string, string>) => vars.set(id, { ...(vars.get(id) ?? {}), ...v });
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

  switch (def.kind) {
    case 'welcome':
      partners = partners.filter((p) => !joinedBefore(7)(p));
      break;
    case 'first_share': {
      const [clicks, sales] = await Promise.all([clickCounts(sb, ago(MESSAGE_CLICK_WINDOW_DAYS)), salesRows(sb)]);
      const sold = new Set(sales.map((r) => r.partner_id));
      partners = partners.filter((p) => joinedBefore(7)(p) && !clicks.get(p.id) && !sold.has(p.id));
      break;
    }
    case 'sales_tip': {
      const [clicks, sales] = await Promise.all([clickCounts(sb, ago(MESSAGE_CLICK_WINDOW_DAYS)), salesRows(sb)]);
      const sold = new Set(sales.map((r) => r.partner_id));
      partners = partners.filter((p) => (clicks.get(p.id) ?? 0) > 0 && !sold.has(p.id));
      for (const p of partners) setVars(p.id, { クリック数: String(clicks.get(p.id)) });
      break;
    }
    case 'first_sale': {
      const sales = await salesRows(sb);
      const agg = new Map<number, { orders: number; commission: number }>();
      for (const r of sales) {
        const a = agg.get(r.partner_id) ?? { orders: 0, commission: 0 };
        a.orders += 1; a.commission += r.commission;
        agg.set(r.partner_id, a);
      }
      partners = partners.filter((p) => agg.has(p.id));
      for (const p of partners) {
        const a = agg.get(p.id)!;
        setVars(p.id, { 注文数: String(a.orders), 報酬見込み: yenText(a.commission) });
      }
      break;
    }
    case 'monthly_report': {
      const month = params.month!;
      const { start, end } = periodRange(month);
      const [clicks, sales] = await Promise.all([clickCounts(sb, start, end), salesRows(sb)]);
      const agg = new Map<number, { orders: number; commission: number }>();
      for (const r of sales) {
        if (r.ordered_at < start || r.ordered_at >= end) continue;
        const a = agg.get(r.partner_id) ?? { orders: 0, commission: 0 };
        a.orders += 1; a.commission += r.commission;
        agg.set(r.partner_id, a);
      }
      partners = partners.filter((p) => (clicks.get(p.id) ?? 0) > 0 || agg.has(p.id));
      for (const p of partners) {
        const a = agg.get(p.id) ?? { orders: 0, commission: 0 };
        setVars(p.id, { 対象月: monthText(month), クリック数: String(clicks.get(p.id) ?? 0), 注文数: String(a.orders), 報酬見込み: yenText(a.commission) });
      }
      break;
    }
    case 'payout_payable':
    case 'payout_carried': {
      const period = params.period!;
      const statuses = def.kind === 'payout_payable' ? ['payable', 'paid'] : ['carried'];
      const { data: rows, error: pErr } = await sb.from('aff_payouts').select('partner_id, gross, net, status').eq('period', period).in('status', statuses);
      if (pErr) throw new Error(pErr.message);
      const byPartner = new Map(((rows ?? []) as Array<{ partner_id: number; gross: number; net: number }>).map((r) => [r.partner_id, r]));
      partners = partners.filter((p) => byPartner.has(p.id));
      for (const p of partners) {
        const r = byPartner.get(p.id)!;
        setVars(p.id, def.kind === 'payout_payable'
          ? { 対象月: monthText(period), 支払額: yenText(r.net), 支払予定日: dateText(dueDateOf(period)) }
          : { 対象月: monthText(period), 繰越額: yenText(r.gross) });
      }
      break;
    }
    case 'dormant': {
      const clicks = await clickCounts(sb, ago(60));
      partners = partners.filter((p) => joinedBefore(60)(p) && !clicks.get(p.id));
      break;
    }
    case 'custom': {
      const f = params.filter ?? parseMessageFilter({});
      if (f.joinedDaysMin > 0) partners = partners.filter(joinedBefore(f.joinedDaysMin));
      if (f.noClicks) {
        const clicks = await clickCounts(sb, ago(MESSAGE_CLICK_WINDOW_DAYS));
        partners = partners.filter((p) => !clicks.get(p.id));
      }
      if (f.noSales) {
        const sold = new Set((await salesRows(sb)).map((r) => r.partner_id));
        partners = partners.filter((p) => !sold.has(p.id));
      }
      break;
    }
  }

  // 다시 보내는 간격 — 보류 중인 것도 «받을 예정»이니 같이 뺀다
  const gap = def.gap;
  if (gap.type === 'filter') {
    const days = params.filter?.skipMessagedDays ?? 0;
    if (days > 0) {
      const since = ago(days);
      const got = idsOf((await history(sb)).filter((h) => h.created_at >= since));
      partners = partners.filter((p) => !got.has(p.id));
    }
  } else {
    const rows = await history(sb, def.kind);
    const since = gap.type === 'days' ? ago(gap.days) : null;
    const key = params.month ?? params.period;
    const got = idsOf(rows.filter((h) =>
      gap.type === 'once' ? true
        : gap.type === 'days' ? h.created_at >= since!
          : (h.filter?.month ?? h.filter?.period) === key));
    partners = partners.filter((p) => !got.has(p.id));
  }

  return partners
    .sort((a, b) => a.joined_at.localeCompare(b.joined_at))
    .map(({ id, code, name, instagram, joined_at }) => ({
      partner: { id, code, name, instagram, joined_at },
      vars: { 名前: name, 紹介リンク: `https://biteme.co.jp/a/${code}`, パートナーページ: PARTNER_PAGE_URL, ...(vars.get(id) ?? {}) },
    }));
}

// ── 상황별 저장 문구 ───────────────────────────────────────────────────────────

/** 저장한 문구 — 표가 아직 없으면(마이그레이션 전) 빈 맵 */
export async function savedTemplates(sb: SupabaseClient): Promise<Map<string, { body: string; updated_at: string }>> {
  const { data, error } = await sb.from('aff_message_templates').select('kind, body, updated_at');
  if (error) { console.error('[affiliate-message] aff_message_templates', error.message); return new Map(); }
  return new Map(((data ?? []) as Array<{ kind: string; body: string; updated_at: string }>).map((r) => [r.kind, { body: r.body, updated_at: r.updated_at }]));
}

function checkBody(def: KindDef, body: string): string | null {
  if (!body.trim()) return '본문은 필수 (일본어)';
  if (body.length > MESSAGE_MAX_LENGTH) return `본문은 ${MESSAGE_MAX_LENGTH.toLocaleString()}자까지`;
  const unknown = unknownVariables(body, def);
  if (unknown.length) return `이 상황에서 쓸 수 없는 변수: ${unknown.map((v) => `{{${v}}}`).join(' ')}`;
  return null;
}

export async function saveTemplate(sb: SupabaseClient, kind: string, body: string): Promise<{ ok: true } | string> {
  const def = kindDef(kind);
  if (!def) return '알 수 없는 상황';
  const text = body.trim();
  const err = checkBody(def, text);
  if (err) return err;
  const { error } = await sb.from('aff_message_templates').upsert({ kind, body: text, updated_at: new Date().toISOString() });
  if (error) return error.message;
  return { ok: true };
}

/** 저장 문구를 지워 기본 문구로 되돌린다 */
export async function resetTemplate(sb: SupabaseClient, kind: string): Promise<{ ok: true } | string> {
  if (!kindDef(kind)) return '알 수 없는 상황';
  const { error } = await sb.from('aff_message_templates').delete().eq('kind', kind);
  if (error) return error.message;
  return { ok: true };
}

// ── 미리 보기 · 보내기 ─────────────────────────────────────────────────────────

export interface PreviewRow extends Recipient { text: string }

export async function previewMessage(sb: SupabaseClient, kind: string, rawParams: unknown, body: string): Promise<{ count: number; recipients: PreviewRow[] } | string> {
  const def = kindDef(kind);
  if (!def) return '알 수 없는 상황';
  const err = checkBody(def, body.trim());
  if (err) return err;
  const params = parseMessageParams(def, rawParams);
  if (typeof params === 'string') return params;
  const targets = await selectTargets(sb, def, params);
  return { count: targets.length, recipients: targets.map((t) => ({ ...t.partner, text: renderBody(body.trim(), t.vars) })) };
}

export interface MessageInput { kind: string; memo: string; body: string; params: unknown; expectedCount: number }

export function parseMessageInput(body: Record<string, unknown>): MessageInput | string {
  const expectedCount = Number(body.expectedCount);
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return '미리 보기 인원(expectedCount) 필요 — 미리 보기를 먼저 해주세요';
  return {
    kind: String(body.kind ?? 'custom'),
    memo: String(body.memo ?? '').trim().slice(0, 100),
    body: String(body.body ?? '').trim(),
    params: body.params ?? (body.filter ? { filter: body.filter } : {}),
    expectedCount,
  };
}

/** 실제로 LINE 을 보낸다 — 지금 활동 중인 사람만, 고정해 둔 사람별 문구로. 끝나면 sent(또는 전원 실패면 failed) */
async function deliver(sb: SupabaseClient, message: AffMessage): Promise<{ sent: number; failed: number }> {
  // 먼저 pending → sent 로 선점한다 — 09:05 크론과 원격 위임이 겹쳐도 한 번만 나간다
  const { data: claimed, error: cErr } = await sb.from('aff_messages').update({ notify_status: 'sent', notified_at: new Date().toISOString() }).eq('id', message.id).eq('notify_status', 'pending').select('id');
  if (cErr) throw new Error(cErr.message);
  if (!claimed || claimed.length === 0) return { sent: 0, failed: 0 };

  // #271 로 만든 옛 행은 rendered 가 비어 있다 — 그땐 본문을 모두에게 그대로
  const rendered = message.rendered?.length ? message.rendered : message.partner_ids.map((id) => ({ partner_id: Number(id), text: message.body }));
  let r = { sent: 0, failed: rendered.length };
  try {
    const { data, error } = await sb.from('aff_partners').select('id, line_user_id').in('id', rendered.map((x) => Number(x.partner_id))).eq('status', 'active');
    if (error) throw new Error(error.message);
    const lineById = new Map(((data ?? []) as Array<Pick<AffPartner, 'id' | 'line_user_id'>>).map((p) => [p.id, p.line_user_id]));
    // 같은 문구끼리 묶어 multicast — 변수가 사람마다 다르면 한 사람씩 나간다
    const groups = new Map<string, string[]>();
    for (const x of rendered) {
      const line = lineById.get(Number(x.partner_id));
      if (line) groups.set(x.text, [...(groups.get(x.text) ?? []), line]);
    }
    const entries = [...groups.entries()];
    r = { sent: 0, failed: 0 };
    for (let i = 0; i < entries.length; i += SEND_CONCURRENCY) {
      const results = await Promise.all(entries.slice(i, i + SEND_CONCURRENCY).map(([text, ids]) => multicastLine(ids, text)));
      for (const x of results) { r.sent += x.sent; r.failed += x.failed; }
    }
  } catch (e) {
    console.error('[affiliate-message] 발송 실패', message.id, e);
  }
  const status = r.sent === 0 && r.failed > 0 ? 'failed' : 'sent';
  await sb.from('aff_messages').update({ notify_status: status, sent_count: r.sent, failed_count: r.failed }).eq('id', message.id);
  return r;
}

export async function createMessage(sb: SupabaseClient, input: MessageInput): Promise<{ message: AffMessage; notified: { sent: number; failed: number }; notifyPending: boolean } | string> {
  const def = kindDef(input.kind);
  if (!def) return '알 수 없는 상황';
  const err = checkBody(def, input.body);
  if (err) return err;
  const params = parseMessageParams(def, input.params);
  if (typeof params === 'string') return params;

  const targets = await selectTargets(sb, def, params);
  if (targets.length === 0) return '조건에 맞는 파트너가 없습니다';
  // 미리 보기 뒤에 명단이 바뀌었으면 보내지 않는다 — 본 숫자와 실제 나가는 숫자가 같아야 한다
  if (targets.length !== input.expectedCount) return `미리 보기(${input.expectedCount}명) 뒤에 대상이 ${targets.length}명으로 바뀌었습니다. 미리 보기를 다시 해주세요`;

  const { data, error } = await sb
    .from('aff_messages')
    .insert({
      kind: def.kind,
      memo: input.memo || def.label,
      body: input.body,
      filter: params,
      partner_ids: targets.map((t) => t.partner.id),
      rendered: targets.map((t) => ({ partner_id: t.partner.id, text: renderBody(input.body, t.vars) })),
      notify_status: 'pending',
    })
    .select('*')
    .single();
  if (error || !data) return error?.message ?? '저장 실패';
  const message = data as AffMessage;

  const notifyPending = inQuietHours();
  let notified = { sent: 0, failed: 0 };
  if (!notifyPending) {
    if (canSendLineHere()) notified = await deliver(sb, message);
    else {
      // 어드민 프로젝트엔 LINE 키가 없다 — 본 사이트가 보류분을 보낸다
      const r = await triggerRemoteNotify();
      notified = r.ok ? { sent: r.messagesSent, failed: 0 } : { sent: 0, failed: 1 };
      if (!r.ok) console.error('[affiliate-message] 원격 발송 실패 — 내일 09:05 크론이 다시 보낸다', r.error);
    }
  }
  return { message, notified, notifyPending };
}

/** 아직 안 나간 것만 취소(삭제)할 수 있다 — 보낸 건 기록으로 남긴다 */
export async function cancelMessage(sb: SupabaseClient, id: number): Promise<{ ok: true } | string> {
  const { data, error } = await sb.from('aff_messages').select('id, notify_status').eq('id', id).maybeSingle();
  if (error) return error.message;
  if (!data) return '메시지 없음';
  if ((data as { notify_status: string }).notify_status !== 'pending') return '이미 보낸 메시지는 취소할 수 없음 (발송 기록)';
  const { error: dErr } = await sb.from('aff_messages').delete().eq('id', id).eq('notify_status', 'pending');
  if (dErr) return dErr.message;
  return { ok: true };
}

/** 야간 보류분 — 크론(09:05 JST)과 원격 위임이 부른다. 표가 아직 없으면(마이그레이션 전) 조용히 0 */
export async function flushPendingMessages(sb: SupabaseClient): Promise<{ messages: number; sent: number }> {
  const { data, error } = await sb.from('aff_messages').select('*').eq('notify_status', 'pending');
  if (error) {
    if (/aff_messages/.test(error.message)) return { messages: 0, sent: 0 };
    throw new Error(error.message);
  }
  let sent = 0;
  for (const m of (data ?? []) as AffMessage[]) sent += (await deliver(sb, m)).sent;
  return { messages: (data ?? []).length, sent };
}

/** 발송 내역 — 사람별 문구(rendered)는 무거우니 목록엔 빼고, 받은 사람 코드만 붙인다 */
export async function listMessages(sb: SupabaseClient): Promise<Array<Omit<AffMessage, 'rendered'>>> {
  const { data, error } = await sb
    .from('aff_messages')
    .select('id, kind, memo, body, filter, partner_ids, notify_status, sent_count, failed_count, notified_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) { console.error('[affiliate-admin] aff_messages', error.message); return []; }
  return (data ?? []) as Array<Omit<AffMessage, 'rendered'>>;
}

/** 어드민 화면용 상황 목록 — 정의 + 저장 문구 + 마지막 발송 + 고를 수 있는 정산 월 */
export async function messageKindsView(sb: SupabaseClient, messages: Array<Pick<AffMessage, 'kind' | 'created_at' | 'partner_ids' | 'notify_status'>>) {
  const [saved, periodsQ] = await Promise.all([
    savedTemplates(sb),
    sb.from('aff_payouts').select('period').order('period', { ascending: false }).limit(1000),
  ]);
  const periods = [...new Set(((periodsQ.data ?? []) as Array<{ period: string }>).map((r) => r.period))];
  return {
    kinds: KIND_DEFS.map((d) => {
      const last = messages.find((m) => (m.kind ?? 'custom') === d.kind && m.notify_status !== 'failed');
      return {
        ...d,
        body: saved.get(d.kind)?.body ?? d.defaultBody,
        customized: saved.has(d.kind),
        savedAt: saved.get(d.kind)?.updated_at ?? null,
        lastSentAt: last?.created_at ?? null,
        lastCount: last?.partner_ids.length ?? 0,
      };
    }),
    defaultMonth: previousPeriodJst(),
    periods,
  };
}
