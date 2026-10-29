/**
 * 어필리에이트 — 파트너에게 메시지 (Issue #270)
 *
 *  - 어드민에서 조건(최근 30일 클릭 0·판매 0·가입 N일 지남·최근 N일 안에 받은 사람 제외)으로 대상을 고르고,
 *    미리 보기로 명단을 확인한 뒤 보낸다. 자동 발송은 없다 — 사람이 「보내기」를 눌러야 나간다.
 *  - 받는 사람은 보내기를 누른 순간 partner_ids 로 고정한다. 야간 보류분도 그 명단 그대로(단, 그새 정지·탈퇴한 사람은 뺀다).
 *  - 야간(21~9시 JST)이면 pending 으로 두고 다음 날 09:05 크론(?task=notify)이 보낸다 — 캠페인 알림·개정 통지와 같은 규칙.
 *  - 본문은 손대지 않고 그대로 보낸다. 머리말·링크는 어드민에서 쓴 문구가 전부다.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { MANUAL_LINE_ID_PREFIX, fetchAllRows, type AffPartner } from './_affiliate.js';
import { canSendLineHere, inQuietHours, multicastLine, triggerRemoteNotify } from './_affiliate-campaign.js';

/** 「클릭 0」을 보는 기간 */
export const MESSAGE_CLICK_WINDOW_DAYS = 30;
/** LINE 텍스트 한 통은 5,000자까지 — 읽히는 길이로 더 짧게 막는다 */
export const MESSAGE_MAX_LENGTH = 1500;

export interface MessageFilter {
  /** 최근 30일 클릭이 0인 사람만 */
  noClicks: boolean;
  /** 판매(확정 대기·확정)가 0건인 사람만 */
  noSales: boolean;
  /** 가입하고 이만큼 지난 사람만 (0 = 조건 없음) */
  joinedDaysMin: number;
  /** 최근 이만큼 안에 메시지를 받은 사람은 뺀다 (0 = 빼지 않음) */
  skipMessagedDays: number;
}

export interface AffMessage {
  id: number;
  memo: string;
  body: string;
  filter: MessageFilter;
  partner_ids: number[];
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

export interface Recipient { id: number; code: string; name: string; instagram: string | null; joined_at: string }

/** 조건에 맞는 활동 파트너 — 미리 보기와 보내기가 같은 함수를 쓴다 */
export async function selectRecipients(sb: SupabaseClient, filter: MessageFilter, now = new Date()): Promise<Recipient[]> {
  const { data, error } = await sb.from('aff_partners').select('id, code, name, instagram, joined_at, line_user_id').eq('status', 'active');
  if (error) throw new Error(error.message);
  // 수동 등록 파트너는 LINE 이 없어 받을 수 없다
  let partners = ((data ?? []) as Array<Pick<AffPartner, 'id' | 'code' | 'name' | 'instagram' | 'joined_at' | 'line_user_id'>>)
    .filter((p) => !p.line_user_id.startsWith(MANUAL_LINE_ID_PREFIX));

  if (filter.joinedDaysMin > 0) {
    const before = now.getTime() - filter.joinedDaysMin * 86400_000;
    partners = partners.filter((p) => new Date(p.joined_at).getTime() <= before);
  }
  if (filter.noClicks) {
    const since = new Date(now.getTime() - MESSAGE_CLICK_WINDOW_DAYS * 86400_000).toISOString();
    const rows = await fetchAllRows<{ partner_id: number }>((from, to) => sb.from('aff_clicks').select('partner_id').eq('is_bot', false).gte('ts', since).order('id').range(from, to));
    const clicked = new Set(rows.map((r) => r.partner_id));
    partners = partners.filter((p) => !clicked.has(p.id));
  }
  if (filter.noSales) {
    const rows = await fetchAllRows<{ partner_id: number }>((from, to) => sb.from('aff_conversions').select('partner_id').in('status', ['pending', 'confirmed']).order('id').range(from, to));
    const sold = new Set(rows.map((r) => r.partner_id));
    partners = partners.filter((p) => !sold.has(p.id));
  }
  if (filter.skipMessagedDays > 0) {
    const since = new Date(now.getTime() - filter.skipMessagedDays * 86400_000).toISOString();
    // 보류 중인 것도 «받을 예정»이니 같이 뺀다 — 실패한 건 안 받았으니 빼지 않는다
    const { data: recent, error: mErr } = await sb.from('aff_messages').select('partner_ids').in('notify_status', ['pending', 'sent']).gte('created_at', since);
    if (mErr) throw new Error(mErr.message);
    const messaged = new Set(((recent ?? []) as Array<{ partner_ids: number[] }>).flatMap((m) => m.partner_ids.map(Number)));
    partners = partners.filter((p) => !messaged.has(p.id));
  }
  return partners
    .map(({ id, code, name, instagram, joined_at }) => ({ id, code, name, instagram, joined_at }))
    .sort((a, b) => a.joined_at.localeCompare(b.joined_at));
}

/** 실제로 LINE 을 보낸다 — 지금 활동 중인 사람만. 끝나면 sent(또는 전원 실패면 failed) */
async function deliver(sb: SupabaseClient, message: AffMessage): Promise<{ sent: number; failed: number }> {
  // 먼저 pending → sent 로 선점한다 — 09:05 크론과 원격 위임이 겹쳐도 한 번만 나간다
  const { data: claimed, error: cErr } = await sb.from('aff_messages').update({ notify_status: 'sent', notified_at: new Date().toISOString() }).eq('id', message.id).eq('notify_status', 'pending').select('id');
  if (cErr) throw new Error(cErr.message);
  if (!claimed || claimed.length === 0) return { sent: 0, failed: 0 };

  let r = { sent: 0, failed: message.partner_ids.length };
  try {
    const { data, error } = await sb.from('aff_partners').select('line_user_id').in('id', message.partner_ids.map(Number)).eq('status', 'active');
    if (error) throw new Error(error.message);
    const lineIds = ((data ?? []) as Array<Pick<AffPartner, 'line_user_id'>>).map((p) => p.line_user_id);
    r = await multicastLine(lineIds, message.body);
  } catch (e) {
    console.error('[affiliate-message] 발송 실패', message.id, e);
  }
  const status = r.sent === 0 && r.failed > 0 ? 'failed' : 'sent';
  await sb.from('aff_messages').update({ notify_status: status, sent_count: r.sent, failed_count: r.failed }).eq('id', message.id);
  return r;
}

export interface MessageInput { memo: string; body: string; filter: MessageFilter; expectedCount: number }

export function parseMessageInput(body: Record<string, unknown>): MessageInput | string {
  const text = String(body.body ?? '').trim();
  const memo = String(body.memo ?? '').trim().slice(0, 100);
  const expectedCount = Number(body.expectedCount);
  if (!text) return '본문은 필수 (일본어)';
  if (text.length > MESSAGE_MAX_LENGTH) return `본문은 ${MESSAGE_MAX_LENGTH.toLocaleString()}자까지`;
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return '미리 보기 인원(expectedCount) 필요 — 미리 보기를 먼저 해주세요';
  return { memo, body: text, filter: parseMessageFilter(body.filter), expectedCount };
}

export async function createMessage(sb: SupabaseClient, input: MessageInput): Promise<{ message: AffMessage; notified: { sent: number; failed: number }; notifyPending: boolean } | string> {
  const recipients = await selectRecipients(sb, input.filter);
  if (recipients.length === 0) return '조건에 맞는 파트너가 없습니다';
  // 미리 보기 뒤에 명단이 바뀌었으면 보내지 않는다 — 본 숫자와 실제 나가는 숫자가 같아야 한다
  if (recipients.length !== input.expectedCount) return `미리 보기(${input.expectedCount}명) 뒤에 대상이 ${recipients.length}명으로 바뀌었습니다. 미리 보기를 다시 해주세요`;

  const { data, error } = await sb
    .from('aff_messages')
    .insert({ memo: input.memo, body: input.body, filter: input.filter, partner_ids: recipients.map((r) => r.id), notify_status: 'pending' })
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

export async function listMessages(sb: SupabaseClient): Promise<AffMessage[]> {
  const { data, error } = await sb.from('aff_messages').select('*').order('created_at', { ascending: false }).limit(20);
  if (error) { console.error('[affiliate-admin] aff_messages', error.message); return []; }
  return (data ?? []) as AffMessage[];
}
