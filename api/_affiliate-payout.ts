/**
 * 어필리에이트 월 정산 (#178 Phase 3, 약관 第5条 · 설계 §6 aff_payouts)
 *
 *  - 월 마감: 그 달 말일까지 확정(confirmed)됐고 아직 어느 정산에도 안 묶인 전환을 파트너별로 합친다.
 *    이전 달에서 이월된 금액(carried)도 함께 합친다. 합계가 ¥3,000 이상이면 payable, 미만이면 carried(다음 달로).
 *    payout.gross 는 언제나 「이월분까지 합친 총액」이다 — 이월 사슬의 마지막 행 하나만 보면 된다.
 *  - 다시 마감: 그 달에 지급 처리(paid)된 건이 하나도 없을 때만. 기존 행을 지우고 다시 계산한다
 *    (aff_conversions.payout_id 는 FK on delete set null 이라 자동으로 풀린다).
 *  - 지급 처리: payable → paid, paid_at, dispute_until = 지급일 + 30일(第5条 5항).
 *  - 원천징수는 기본 0 — 세무사 답이 「대상」이면 그때 withholding 을 채운다(第5条 3항).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './_affiliate.js';

/** 최소 지급액 — 미만은 이월 (약관 第5条 2항) */
export const MIN_PAYOUT = 3000;
export const DISPUTE_DAYS = 30;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' 의 JST 월 경계 → UTC ISO [start, end) */
export function periodRange(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600_000).toISOString();
  const end = new Date(Date.UTC(y, m, 1) - 9 * 3600_000).toISOString();
  return { start, end };
}

/** 지금(JST)이 속한 달 'YYYY-MM' */
export function currentPeriodJst(now = new Date()): string {
  const j = new Date(now.getTime() + 9 * 3600_000);
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 지급 예정일 = 마감 월의 다음 달 말일 (第5条 1항) */
export function dueDateOf(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
}

interface PayoutRow {
  id: number;
  partner_id: number;
  period: string;
  gross: number;
  withholding: number;
  net: number;
  status: 'draft' | 'carried' | 'payable' | 'paid' | 'void';
  carried_from: number[];
  paid_at: string | null;
  dispute_until: string | null;
}

export interface PartnerPayoutPlan {
  partnerId: number;
  conversionIds: number[];
  own: number;          // 이번 달 확정분
  carriedIds: number[]; // 합쳐지는 이월 행
  carriedIn: number;    // 이월분 합
  total: number;
  status: 'payable' | 'carried';
}

/** 순수 계산 — 테스트용으로 분리. 전환·이월을 받아 파트너별 계획을 만든다 */
export function planPayouts(
  conversions: Array<{ id: number; partner_id: number; commission: number }>,
  openCarried: Array<{ id: number; partner_id: number; gross: number }>
): PartnerPayoutPlan[] {
  const byPartner = new Map<number, PartnerPayoutPlan>();
  const get = (pid: number) => {
    let p = byPartner.get(pid);
    if (!p) { p = { partnerId: pid, conversionIds: [], own: 0, carriedIds: [], carriedIn: 0, total: 0, status: 'carried' }; byPartner.set(pid, p); }
    return p;
  };
  for (const c of conversions) { const p = get(c.partner_id); p.conversionIds.push(c.id); p.own += c.commission; }
  for (const c of openCarried) { const p = get(c.partner_id); p.carriedIds.push(c.id); p.carriedIn += c.gross; }
  const plans: PartnerPayoutPlan[] = [];
  for (const p of byPartner.values()) {
    // 이번 달 확정분이 없으면 이월만 있는 파트너는 건드리지 않는다 — 다음에 확정분이 생길 때 합쳐진다
    if (p.conversionIds.length === 0) continue;
    p.total = p.own + p.carriedIn;
    p.status = p.total >= MIN_PAYOUT ? 'payable' : 'carried';
    plans.push(p);
  }
  return plans.sort((a, b) => b.total - a.total);
}

export interface CloseResult {
  period: string;
  payable: number;   // 지급 대상 파트너 수
  carried: number;   // 이월 파트너 수
  totalPayable: number;
  conversions: number;
}

export async function closeMonth(sb: SupabaseClient, period: string): Promise<CloseResult | string> {
  if (!PERIOD_RE.test(period)) return '기간은 YYYY-MM';
  if (period >= currentPeriodJst()) return `${period} 는 아직 끝나지 않은 달 — 지난 달만 마감할 수 있음`;

  // 이 달 뒤에 마감된 달이 있으면 이월 사슬이 꼬인다 — 순서대로만
  const { count: later, error: lErr } = await sb.from('aff_payouts').select('id', { count: 'exact', head: true }).gt('period', period);
  if (lErr) return lErr.message;
  if ((later ?? 0) > 0) return `${period} 보다 뒤 달이 이미 마감돼 있음 — 뒤 달부터 지급 전이면 뒤 달을 먼저 다시 마감할 것`;

  // 다시 마감 — 지급된 건이 있으면 거절, 없으면 기존 행을 지우고 새로
  const { data: existing, error: eErr } = await sb.from('aff_payouts').select('id, status').eq('period', period);
  if (eErr) return eErr.message;
  const rows = (existing ?? []) as Array<{ id: number; status: string }>;
  if (rows.some((r) => r.status === 'paid')) return `${period} 에 이미 지급 처리된 건이 있어 다시 마감할 수 없음`;
  if (rows.length > 0) {
    const { error } = await sb.from('aff_payouts').delete().in('id', rows.map((r) => r.id));
    if (error) return error.message;
  }

  const { end } = periodRange(period);
  let convs: Array<{ id: number; partner_id: number; commission: number }>;
  try {
    // 1,000행 넘어도 끝까지 — 잘리면 확정분 일부가 그 달 명세에서 빠진다
    convs = await fetchAllRows<{ id: number; partner_id: number; commission: number }>((from, to) =>
      sb.from('aff_conversions').select('id, partner_id, commission').eq('status', 'confirmed').lt('confirmed_at', end).is('payout_id', null).order('id').range(from, to));
  } catch (e) {
    return e instanceof Error ? e.message : '확정분 조회 실패';
  }

  // 아직 아무 정산에도 합쳐지지 않은 이월 행 = 다른 행의 carried_from 에 없는 carried
  type CarryRow = Pick<PayoutRow, 'id' | 'partner_id' | 'gross' | 'status' | 'carried_from'>;
  let allPayouts: CarryRow[];
  try {
    allPayouts = await fetchAllRows<CarryRow>((from, to) => sb.from('aff_payouts').select('id, partner_id, gross, status, carried_from').lt('period', period).order('id').range(from, to));
  } catch (e) {
    return e instanceof Error ? e.message : '이월분 조회 실패';
  }
  const absorbed = new Set(allPayouts.flatMap((p) => p.carried_from ?? []));
  const openCarried = allPayouts.filter((p) => p.status === 'carried' && !absorbed.has(p.id));

  const plans = planPayouts(convs, openCarried);
  let conversions = 0;
  for (const p of plans) {
    const { data: ins, error } = await sb
      .from('aff_payouts')
      .insert({ partner_id: p.partnerId, period, gross: p.total, withholding: 0, net: p.total, status: p.status, carried_from: p.carriedIds })
      .select('id')
      .single();
    if (error || !ins) return `파트너 ${p.partnerId} 정산 저장 실패: ${error?.message}`;
    // id 목록은 URL 에 실리므로 200개씩
    for (let i = 0; i < p.conversionIds.length; i += 200) {
      const { error: uErr } = await sb.from('aff_conversions').update({ payout_id: (ins as { id: number }).id }).in('id', p.conversionIds.slice(i, i + 200));
      if (uErr) return `파트너 ${p.partnerId} 전환 묶기 실패: ${uErr.message}`;
    }
    conversions += p.conversionIds.length;
  }

  const payable = plans.filter((p) => p.status === 'payable');
  return {
    period,
    payable: payable.length,
    carried: plans.length - payable.length,
    totalPayable: payable.reduce((a, p) => a + p.total, 0),
    conversions,
  };
}

/** 지급 처리 — payable 만. 지급일 기준 30일 이의신청 기한을 남긴다 */
export async function markPaid(sb: SupabaseClient, payoutIds: number[], paidAt = new Date()): Promise<{ paid: number } | string> {
  if (payoutIds.length === 0) return 'payoutIds 필요';
  const { data, error } = await sb.from('aff_payouts').select('id, status').in('id', payoutIds);
  if (error) return error.message;
  const found = (data ?? []) as Array<{ id: number; status: string }>;
  const missing = payoutIds.filter((id) => !found.some((p) => p.id === id));
  if (missing.length > 0) return `없는 정산 id: ${missing.join(', ')}`;
  const bad = found.filter((p) => p.status !== 'payable');
  if (bad.length > 0) return `지급 대상(payable)이 아닌 건이 섞여 있음: ${bad.map((b) => `#${b.id} ${b.status}`).join(', ')}`;
  const disputeUntil = new Date(paidAt.getTime() + DISPUTE_DAYS * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const { error: uErr } = await sb
    .from('aff_payouts')
    .update({ status: 'paid', paid_at: paidAt.toISOString(), dispute_until: disputeUntil })
    .in('id', payoutIds);
  if (uErr) return uErr.message;
  return { paid: payoutIds.length };
}

/**
 * 전환 무효 — 광고 표기 미비 등 약관 위반 성과 취소(第8条·第12条 2항). 정산에 묶이기 전 건만.
 * 커미션은 0 으로, 사유는 raw.void_reason 에 남긴다.
 */
export async function voidConversion(sb: SupabaseClient, conversionId: number, reason: string): Promise<{ ok: true } | string> {
  const { data, error } = await sb.from('aff_conversions').select('id, status, payout_id, raw').eq('id', conversionId).maybeSingle();
  if (error) return error.message;
  if (!data) return '전환 없음';
  const c = data as { id: number; status: string; payout_id: number | null; raw: Record<string, unknown> };
  if (c.payout_id != null) return '이미 정산에 묶인 건 — 그 달을 다시 마감하기 전엔 무효로 못 바꿈';
  if (!['pending', 'confirmed'].includes(c.status)) return `${c.status} 상태는 무효 처리 대상이 아님`;
  const { error: uErr } = await sb
    .from('aff_conversions')
    .update({ status: 'void', commission: 0, raw: { ...c.raw, void_reason: reason.slice(0, 300), voided_at: new Date().toISOString(), before_status: c.status } })
    .eq('id', conversionId);
  if (uErr) return uErr.message;
  return { ok: true };
}
