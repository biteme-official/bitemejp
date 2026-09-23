/**
 * 어필리에이트 규약 개정 통지 (#178 Phase 3, 약관 第11条 2항 · 설계 §8 표)
 *
 *  - 시행 14일 전까지 LINE 으로 알리고, 파트너 페이지에 배너를 띄운다.
 *  - 재동의는 받지 않는다 — 시행 후 계속 이용하면 동의로 본다(第11条 4항). 그래서 통지 자체가 기록이다.
 *  - 야간(21~9시 JST)에 등록하면 notify_status='pending' 으로 두고 다음 날 09:05 크론이 보낸다.
 *  - 실제 약관 본문은 코드(src/data/affiliate-terms.ts)에 있다 — 시행일에 버전을 올리는 PR 이 따로 필요하다.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AffPartner } from './_affiliate.js';
import { inQuietHours, multicastLine } from './_affiliate-campaign.js';

/** 시행일은 등록 시점부터 최소 14일 뒤 (第11条 2항) */
export const NOTICE_MIN_DAYS = 14;
/** 파트너 페이지 배너를 시행 후에도 이만큼 더 보여준다 */
export const NOTICE_SHOW_AFTER_DAYS = 30;

export interface AffNotice {
  id: number;
  kind: 'terms';
  title: string;
  body: string;
  terms_version: string | null;
  effective_at: string;
  notify_status: 'none' | 'pending' | 'sent';
  notified_at: string | null;
  created_at: string;
}

/** 통지가 실제로 나가는 시각 — 낮이면 지금, 야간(21~9시 JST)이면 다음 09:05 JST */
export function notifySendTime(now = new Date()): Date {
  if (!inQuietHours(now)) return now;
  const j = new Date(now.getTime() + 9 * 3600_000);
  const nine = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate(), 9, 5) - 9 * 3600_000;
  return new Date(j.getUTCHours() >= 21 ? nine + 86400_000 : nine);
}

export interface NoticeInput { title: string; body: string; effectiveAt: string; termsVersion: string | null }

export function parseNoticeInput(body: Record<string, unknown>, now = new Date()): NoticeInput | string {
  const title = String(body.title ?? '').trim();
  const text = String(body.body ?? '').trim();
  const effective = new Date(String(body.effectiveAt ?? ''));
  const termsVersion = String(body.termsVersion ?? '').trim() || null;
  if (!title) return '제목은 필수 (일본어)';
  if (!text) return '개정 요지는 필수 (일본어)';
  if (text.length > 1500) return '개정 요지는 1,500자까지 — LINE 한 통에 들어가야 함';
  if (Number.isNaN(effective.getTime())) return '시행일이 날짜가 아님';
  // 14일은 「실제로 LINE 이 가는 시각」부터 센다 — 야간 등록이면 다음 날 09:05 발송이므로 그 시각 기준. 1분 여유
  const sendAt = notifySendTime(now);
  if (effective.getTime() - sendAt.getTime() < NOTICE_MIN_DAYS * 86400_000 - 60_000) {
    return `시행일은 LINE 발송 시각(${inQuietHours(now) ? '내일 09:05' : '지금'})부터 ${NOTICE_MIN_DAYS}일 뒤 이후여야 함 (약관 第11条 2항)`;
  }
  if (termsVersion && !/^\d{4}-\d{2}$/.test(termsVersion)) return '약관 버전은 YYYY-MM (예: 2026-12)';
  return { title, body: text, effectiveAt: effective.toISOString(), termsVersion };
}

const jstDate = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};

export function noticeMessage(n: Pick<AffNotice, 'title' | 'body' | 'effective_at'>): string {
  return [
    '【BITE ME アフィリエイト】利用規約改定のお知らせ',
    '',
    n.title,
    `効力発生日：${jstDate(n.effective_at)}`,
    '',
    n.body,
    '',
    '効力発生日以降も紹介リンクの掲載またはパートナーページのご利用を続けた場合、改定後の規約に同意いただいたものとみなします（規約第11条）。同意いただけない場合は、パートナーページから参加を終了できます。',
    '詳細はパートナーページから',
    'https://biteme.co.jp/partner',
  ].join('\n');
}

/** 활동 파트너 전원에게 한 번에 보내고 sent 로 */
export async function sendNotice(sb: SupabaseClient, notice: AffNotice): Promise<{ sent: number; failed: number }> {
  const { data } = await sb.from('aff_partners').select('line_user_id').eq('status', 'active');
  const ids = ((data ?? []) as Array<Pick<AffPartner, 'line_user_id'>>).map((p) => p.line_user_id);
  const r = await multicastLine(ids, noticeMessage(notice));
  await sb.from('aff_notices').update({ notify_status: 'sent', notified_at: new Date().toISOString() }).eq('id', notice.id);
  return r;
}

export async function createNotice(sb: SupabaseClient, input: NoticeInput): Promise<{ notice: AffNotice; notified: { sent: number; failed: number }; notifyPending: boolean } | string> {
  const { data, error } = await sb
    .from('aff_notices')
    .insert({ kind: 'terms', title: input.title, body: input.body, terms_version: input.termsVersion, effective_at: input.effectiveAt, notify_status: 'pending' })
    .select('*')
    .single();
  if (error || !data) return error?.message ?? '저장 실패';
  const notice = data as AffNotice;
  const notifyPending = inQuietHours();
  const notified = notifyPending ? { sent: 0, failed: 0 } : await sendNotice(sb, notice);
  return { notice, notified, notifyPending };
}

/** 아직 안 보낸 통지만 지울 수 있다 — 보낸 뒤엔 그 자체가 통지 기록이다 */
export async function deleteNotice(sb: SupabaseClient, id: number): Promise<{ ok: true } | string> {
  const { data, error } = await sb.from('aff_notices').select('id, notify_status').eq('id', id).maybeSingle();
  if (error) return error.message;
  if (!data) return '통지 없음';
  if ((data as { notify_status: string }).notify_status === 'sent') return '이미 LINE 으로 보낸 통지는 지울 수 없음 (통지 기록)';
  const { error: dErr } = await sb.from('aff_notices').delete().eq('id', id);
  if (dErr) return dErr.message;
  return { ok: true };
}

export async function flushPendingNotices(sb: SupabaseClient): Promise<{ notices: number; sent: number }> {
  const { data, error } = await sb.from('aff_notices').select('*').eq('notify_status', 'pending');
  if (error) throw new Error(error.message);
  let sent = 0;
  for (const n of (data ?? []) as AffNotice[]) sent += (await sendNotice(sb, n)).sent;
  return { notices: (data ?? []).length, sent };
}

/** 파트너 페이지 배너 — 시행 전 + 시행 후 30일까지. 표가 아직 없으면(마이그레이션 전) 빈 배열 */
export async function activeNotices(sb: SupabaseClient, now = new Date()): Promise<Array<Pick<AffNotice, 'title' | 'body' | 'effective_at' | 'terms_version'>>> {
  const since = new Date(now.getTime() - NOTICE_SHOW_AFTER_DAYS * 86400_000).toISOString();
  const { data, error } = await sb.from('aff_notices').select('title, body, effective_at, terms_version').gte('effective_at', since).order('effective_at', { ascending: true });
  if (error) { console.error('[affiliate-notice] 조회 실패', error.message); return []; }
  return (data ?? []) as Array<Pick<AffNotice, 'title' | 'body' | 'effective_at' | 'terms_version'>>;
}
