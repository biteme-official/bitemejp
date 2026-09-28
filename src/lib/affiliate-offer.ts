/**
 * 파트너 링크 자동 할인 — 브라우저 쪽 (#178, 2026-09-28)
 *
 * /a/:code 를 누르면 /api/aff-click 이 그 파트너의 살아 있는 캠페인 할인(offer)을 돌려준다.
 * 여기 저장해 두었다가 결제(cartStore.createCheckout) 때 코드 입력 없이 붙인다.
 *
 * 규칙 (하영 결정 9/28)
 *  - LINE 로그인 고객만 자동 적용 — 커미션도 회원 주문에만 붙으므로 대상을 맞춘다
 *  - 할인은 캠페인이 지정한 상품에만 (Shopify 코드 자체가 그 상품에만 걸려 있다)
 *  - 웰컴 쿠폰(10%)과 같이 못 쓰므로 할인액이 큰 쪽을 먼저 보낸다
 *  - 다른 파트너 링크를 새로 누르면 이전 offer 는 버린다 — 코드 귀속이 링크 귀속보다 앞서므로
 *    남겨 두면 새 파트너의 실적을 이전 파트너가 가져간다
 */
import { getAffiliateRef, AFFILIATE_WINDOW_MS } from '@/lib/affiliate-ref';

export const AFFILIATE_OFFER_KEY = 'affiliate_offer';

export interface AffiliateOffer {
  partnerCode: string;
  code: string;
  percent: number;
  /** 할인 대상 상품 숫자 id — 비어 있으면 전 상품 */
  productIds: string[];
  endsAt: string;
  /** 저장 시각 (epoch ms) */
  at: number;
}

export function clearAffiliateOffer(): void {
  try { localStorage.removeItem(AFFILIATE_OFFER_KEY); } catch { /* 무시 */ }
}

/** 서버 응답의 offer 를 저장. 형태가 이상하면 저장하지 않는다 */
export function saveAffiliateOffer(partnerCode: string, raw: unknown): void {
  const o = raw as Partial<AffiliateOffer> | null;
  if (!o || typeof o.code !== 'string' || !(Number(o.percent) > 0) || typeof o.endsAt !== 'string') return;
  const offer: AffiliateOffer = {
    partnerCode,
    code: o.code.toUpperCase(),
    percent: Number(o.percent),
    productIds: Array.isArray(o.productIds) ? o.productIds.map(String) : [],
    endsAt: o.endsAt,
    at: Date.now(),
  };
  try { localStorage.setItem(AFFILIATE_OFFER_KEY, JSON.stringify(offer)); } catch { /* 무시 */ }
}

/** 지금 유효한 offer — 캠페인 종료·30일 창·마지막 클릭 파트너와 다르면 null (지난 것은 지운다) */
export function getAffiliateOffer(now = Date.now()): AffiliateOffer | null {
  try {
    const raw = localStorage.getItem(AFFILIATE_OFFER_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as AffiliateOffer;
    const ref = getAffiliateRef();
    const expired = !(new Date(o.endsAt).getTime() > now) || now - o.at > AFFILIATE_WINDOW_MS;
    if (expired || !ref || ref.code !== o.partnerCode || !o.code) { clearAffiliateOffer(); return null; }
    return o;
  } catch {
    return null;
  }
}

const REVALIDATED_KEY = 'affiliate_offer_checked';

/**
 * 방문(탭 세션)마다 한 번, 서버에 지금의 offer 를 다시 묻는다.
 *  - 어드민에서 캠페인을 일찍 끝냈으면 → 지운다 (안 그러면 「自動適用」 안내가 거짓이 된다)
 *  - 링크를 누른 뒤에 캠페인이 시작됐으면 → 새로 받는다
 * 파트너 ref(30일)가 없으면 묻지 않는다. 실패하면 있던 값을 그대로 둔다.
 */
export async function revalidateAffiliateOffer(): Promise<AffiliateOffer | null> {
  const ref = getAffiliateRef();
  if (!ref) return null;
  try { if (sessionStorage.getItem(REVALIDATED_KEY) === ref.code) return getAffiliateOffer(); } catch { /* 무시 */ }
  try {
    const r = await fetch('/api/aff-click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ref.code, check: true }) });
    if (!r.ok) return getAffiliateOffer();
    const d = (await r.json()) as { ok?: boolean; offer?: unknown; skipped?: string };
    if (!d.ok || d.skipped) return getAffiliateOffer();
    if (getAffiliateRef()?.code !== ref.code) return getAffiliateOffer(); // 그사이 다른 링크
    if (d.offer) saveAffiliateOffer(ref.code, d.offer); else clearAffiliateOffer();
    try { sessionStorage.setItem(REVALIDATED_KEY, ref.code); } catch { /* 무시 */ }
  } catch { /* 네트워크 실패 — 있던 값 유지 */ }
  return getAffiliateOffer();
}

const numericId = (gid: string | undefined | null) => (gid ?? '').split('/').pop() ?? '';

/** 이 상품이 offer 대상인가 (상품 gid 또는 숫자 id) */
export function offerAppliesTo(offer: AffiliateOffer, productId: string | undefined | null): boolean {
  if (offer.productIds.length === 0) return true;
  return offer.productIds.includes(numericId(productId));
}

interface LineLike { productId: string; unitPrice: number; quantity: number }

/** offer 로 깎이는 금액(정가 기준 추정) — Shopify 가 실제로 계산하는 값과 엔 단위 반올림 차이는 있을 수 있다 */
export function offerDiscountAmount(offer: AffiliateOffer, lines: LineLike[]): number {
  const base = lines.filter((l) => offerAppliesTo(offer, l.productId)).reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  return Math.floor((base * offer.percent) / 100);
}

/**
 * 결제 코드 순서 결정 — [어필리에이트 코드들 …, 웰컴] 중 무엇을 보낼지.
 * offer 가 없거나 비로그인이면 null(기존 흐름 그대로). 있으면 할인액 큰 쪽을 앞에, 다른 쪽을 뒤에 둔다
 * — 웰컴을 이미 쓴 고객이면 Shopify 가 웰컴을 무시하므로 뒤의 링크 할인이라도 남게.
 */
export function orderOfferAndWelcome(
  offer: AffiliateOffer | null,
  isLoggedIn: boolean,
  welcome: { code: string; percent: number } | null,
  lines: LineLike[],
): { codes: string[]; chosen: 'offer' | 'welcome' } | null {
  if (!offer || !isLoggedIn) return null;
  const offerAmt = offerDiscountAmount(offer, lines);
  if (offerAmt <= 0) return null; // 대상 상품이 카트에 없다
  if (!welcome) return { codes: [offer.code], chosen: 'offer' };
  const welcomeAmt = Math.floor((lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) * welcome.percent) / 100);
  return offerAmt >= welcomeAmt
    ? { codes: [offer.code, welcome.code], chosen: 'offer' }
    : { codes: [welcome.code, offer.code], chosen: 'welcome' };
}
