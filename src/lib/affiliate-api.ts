/**
 * 어필리에이트 파트너 API 클라이언트 (#178 Phase 2) — /affiliate(가입)·/partner(성과) 가 쓴다.
 * 인증은 서명된 lineSessionToken 하나. 토큰은 항상 POST body 로 보낸다(URL·로그에 남기지 않기 위해).
 */
export interface PublicPartner {
  code: string;
  link: string;
  status: 'active' | 'suspended' | 'withdrawn';
  joinedAt: string;
  instagram: string | null;
  invoiceRegNo: string | null;
  termsVersion: string | null;
}

export interface PartnerView {
  ok: true;
  partner: PublicPartner;
  monthStart: string;
  funnel: { clicks: number; orders: number; confirmed: number; paid: number };
  commission: { pendingThisMonth: number; confirmedThisMonth: number; pendingTotal: number; confirmedUnpaid: number };
  recent: Array<{ order: string | null; attribution: string; amount: number; commission: number; status: string; orderedAt: string; confirmAt: string }>;
  campaigns: Array<{ name: string; startsAt: string; endsAt: string; commissionRate: number; discountPercent: number | null; scope: string; code: string | null }>;
  payouts: Array<{ period: string; gross: number; withholding: number; net: number; status: string; paid_at: string | null; dispute_until: string | null }>;
}

export class AffiliateApiError extends Error {
  constructor(public code: string, public httpStatus: number) { super(code); }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AffiliateApiError(typeof data?.error === 'string' ? data.error : `http_${res.status}`, res.status);
  return data as T;
}

export function joinAffiliate(input: { lineSessionToken: string; name?: string; instagram?: string; termsVersion: string }) {
  return post<{ ok: true; created: boolean; partner: PublicPartner }>('/api/affiliate-join', {
    ...input, adultConfirmed: true, termsAgreed: true,
  });
}

export function fetchPartnerView(lineSessionToken: string) {
  return post<PartnerView>('/api/affiliate-partner', { lineSessionToken });
}

export function withdrawPartner(lineSessionToken: string) {
  return post<{ ok: true; partner: PublicPartner }>('/api/affiliate-partner', { lineSessionToken, action: 'withdraw' });
}

export function saveInvoiceRegNo(lineSessionToken: string, invoiceRegNo: string) {
  return post<{ ok: true; partner: PublicPartner }>('/api/affiliate-partner', { lineSessionToken, action: 'invoice', invoiceRegNo });
}
