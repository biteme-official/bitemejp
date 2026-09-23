/**
 * 어필리에이트 이상 감지 (#178 Phase 3, 설계 §7 관리자 「이상 감지」)
 *
 * 장부(aff_conversions)만 보고 어드민에 「사람이 한 번 볼 것」을 띄운다. 자동으로 막거나 무효로 하지 않는다 —
 * 판단은 하영이, 조치는 「무효」·「정지」 버튼으로.
 *  - self       자기구매로 판정된 주문 (30일)
 *  - same_buyer 같은 고객이 같은 파트너 경유로 3번 이상 (30일) — 가족·지인 대리구매 의심(第4条)
 *  - spike      최근 7일 주문이 5건 이상이고 이전 4주 주 평균의 3배 이상
 *  - new_first  가입 14일 안에 첫 주문 — 신규 파트너 첫 성과는 표기(#PR) 확인 대상
 */

export type AnomalyKind = 'self' | 'same_buyer' | 'spike' | 'new_first';

export interface AnomalyRow {
  partner_id: number;
  status: string;
  shopify_customer_id: string | null;
  ordered_at: string;
}

export interface Anomaly {
  kind: AnomalyKind;
  partnerId: number;
  count: number;
  detail: string;
  at: string; // 정렬용 — 가장 최근 관련 주문
}

const DAY = 86400_000;
const COUNTED = new Set(['pending', 'confirmed']);

export const ANOMALY_RULES = {
  windowDays: 30,
  sameBuyerMin: 3,
  spikeMin: 5,
  spikeRatio: 3,
  newPartnerDays: 14,
} as const;

export function detectAnomalies(
  rows: AnomalyRow[],
  partners: Array<{ id: number; joined_at: string }>,
  now = new Date()
): Anomaly[] {
  const t = now.getTime();
  const out: Anomaly[] = [];
  const recent = rows.filter((r) => t - new Date(r.ordered_at).getTime() <= ANOMALY_RULES.windowDays * DAY);
  const latest = (rs: AnomalyRow[]) => rs.reduce((a, r) => (r.ordered_at > a ? r.ordered_at : a), '');

  // self
  const selfBy = new Map<number, AnomalyRow[]>();
  for (const r of recent) if (r.status === 'self') selfBy.set(r.partner_id, [...(selfBy.get(r.partner_id) ?? []), r]);
  for (const [pid, rs] of selfBy) out.push({ kind: 'self', partnerId: pid, count: rs.length, detail: `자기구매 판정 ${rs.length}건 (최근 30일)`, at: latest(rs) });

  // same_buyer
  const pair = new Map<string, AnomalyRow[]>();
  for (const r of recent) {
    if (!COUNTED.has(r.status) || !r.shopify_customer_id) continue;
    const k = `${r.partner_id}:${r.shopify_customer_id}`;
    pair.set(k, [...(pair.get(k) ?? []), r]);
  }
  for (const rs of pair.values()) {
    if (rs.length < ANOMALY_RULES.sameBuyerMin) continue;
    out.push({ kind: 'same_buyer', partnerId: rs[0].partner_id, count: rs.length, detail: `같은 고객이 ${rs.length}번 구매 (최근 30일) — 가족·지인 대리구매인지 확인`, at: latest(rs) });
  }

  // spike
  const byPartner = new Map<number, AnomalyRow[]>();
  for (const r of rows) if (COUNTED.has(r.status) || r.status === 'self') byPartner.set(r.partner_id, [...(byPartner.get(r.partner_id) ?? []), r]);
  for (const [pid, rs] of byPartner) {
    const age = (r: AnomalyRow) => t - new Date(r.ordered_at).getTime();
    const last7 = rs.filter((r) => age(r) <= 7 * DAY);
    const prev = rs.filter((r) => age(r) > 7 * DAY && age(r) <= 35 * DAY).length / 4;
    if (last7.length >= ANOMALY_RULES.spikeMin && last7.length >= ANOMALY_RULES.spikeRatio * Math.max(prev, 1)) {
      out.push({ kind: 'spike', partnerId: pid, count: last7.length, detail: `최근 7일 ${last7.length}건 — 이전 4주 주 평균 ${Math.round(prev * 10) / 10}건`, at: latest(last7) });
    }
  }

  // new_first
  for (const p of partners) {
    const joined = new Date(p.joined_at).getTime();
    if (t - joined > ANOMALY_RULES.newPartnerDays * DAY) continue;
    const rs = (byPartner.get(p.id) ?? []).slice().sort((a, b) => a.ordered_at.localeCompare(b.ordered_at));
    if (rs.length === 0) continue;
    const days = Math.max(0, Math.floor((new Date(rs[0].ordered_at).getTime() - joined) / DAY));
    out.push({ kind: 'new_first', partnerId: p.id, count: rs.length, detail: `가입 ${days}일 만에 첫 주문 (지금까지 ${rs.length}건) — 게시물 #PR 표기 확인`, at: rs[0].ordered_at });
  }

  return out.sort((a, b) => b.at.localeCompare(a.at));
}
