/**
 * 파트너 링크 귀속 — 브라우저 쪽 (설계 §5, #178 Phase 1)
 *
 * /a/:code 를 누르면 여기 30일짜리 ref 가 남고,
 *   - 로그인 상태면 /api/aff-click 이 그 자리에서 서버 터치를 만든다 (주 경로)
 *   - 비로그인이면 나중에 LINE 로그인할 때 state 에 실려 서버 터치로 승격된다 (line-auth.ts)
 *   - 카트 속성 aff_ref / aff_ref_at 으로도 주문에 실린다 (보조 경로 — 별도 PR)
 *
 * 기존 `affiliate_discount`(특별 코드, 1회용)와는 다른 키다. 그쪽은 체크아웃 직후 지워지지만
 * 이 ref 는 30일 창이 끝날 때까지 남는다.
 */
export const AFFILIATE_REF_KEY = 'affiliate_ref';
export const AFFILIATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_RE = /^[A-Z0-9]{4,12}$/;

export interface AffiliateRef {
  code: string;
  /** 클릭 시각 (epoch ms) */
  at: number;
  /** 서버가 준 클릭 행 id — 응답이 늦거나 실패하면 없다 */
  clickId?: number;
}

export function normalizeAffiliateCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/** 30일 창 안의 ref 만 돌려준다. 지난 것은 지운다. */
export function getAffiliateRef(): AffiliateRef | null {
  try {
    const raw = localStorage.getItem(AFFILIATE_REF_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AffiliateRef>;
    const code = normalizeAffiliateCode(v.code);
    if (!code || typeof v.at !== 'number') { localStorage.removeItem(AFFILIATE_REF_KEY); return null; }
    if (Date.now() - v.at > AFFILIATE_WINDOW_MS) { localStorage.removeItem(AFFILIATE_REF_KEY); return null; }
    return { code, at: v.at, ...(typeof v.clickId === 'number' ? { clickId: v.clickId } : {}) };
  } catch {
    return null;
  }
}

export function setAffiliateRef(ref: AffiliateRef): void {
  try { localStorage.setItem(AFFILIATE_REF_KEY, JSON.stringify(ref)); } catch { /* 저장 못 해도 화면은 진행 */ }
}

/** 로그인 state 에 싣는 형태 (api/line-login-state.ts sanitizeAffiliateRef 와 같은 키) */
export function affiliateRefForLoginState(): { c: string; t: number; k?: number } | null {
  const ref = getAffiliateRef();
  if (!ref) return null;
  return { c: ref.code, t: ref.at, ...(ref.clickId ? { k: ref.clickId } : {}) };
}
