/**
 * /a/:code?p=/product/123 — 파트너 링크 (설계 §5, #178 Phase 1)
 *
 * 화면을 보여주지 않는다(클릭 손실). ref 를 30일 저장하고, 클릭 기록을 비동기로 쏜 뒤
 * 바로 목적지로 보낸다. 기록이 실패해도·서버가 죽어 있어도 고객은 그대로 상품을 본다.
 *
 * 기존 /discount/:code 는 할인이 붙은 특별 코드용으로 그대로 둔다.
 */
import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { getAffiliateRef, normalizeAffiliateCode, setAffiliateRef } from '@/lib/affiliate-ref';

function safeInternalPath(raw: string | null): string {
  if (!raw) return '/';
  const p = raw.trim();
  // 사이트 내부 경로만. 프로토콜·호스트가 붙은 값은 오픈 리다이렉트라 버린다.
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/a/')) return '/';
  return p;
}

export default function AffiliateLink() {
  const { code: rawCode } = useParams<{ code: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const code = normalizeAffiliateCode(rawCode);
    const dest = safeInternalPath(searchParams.get('p'));

    if (code) {
      // 같은 링크를 또 눌러도 새 클릭이다 — 마지막 클릭이 이긴다(약관 第3条 5항)
      const at = Date.now();
      setAffiliateRef({ code, at });

      const lineSessionToken = useAuthStore.getState().user?.lineSessionToken;
      // 비로그인이면 도착 페이지에 LINE 로그인 띠(LoginBanner, 웰컴 쿠폰 문구)가 보이게 스누즈를 푼다 (설계 §7).
      // 구매자는 파트너 실적을 위해 로그인하지 않는다 — 자기 할인 때문에 한다.
      if (!lineSessionToken) { try { localStorage.removeItem('login_banner_dismissed_at'); } catch { /* 무시 */ } }
      // keepalive: 곧바로 페이지가 바뀌어도 요청은 살아남는다. 응답은 기다리지 않는다.
      fetch('/api/aff-click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, path: dest, ...(lineSessionToken ? { lineSessionToken } : {}) }),
        keepalive: true,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { clickId?: number } | null) => {
          // 응답이 오면 clickId 를 보태 둔다 — 카트 속성·로그인 승격이 같은 클릭을 가리키게
          const cur = getAffiliateRef();
          if (d?.clickId && cur && cur.code === code && cur.at === at) setAffiliateRef({ ...cur, clickId: d.clickId });
        })
        .catch(() => { /* 기록 실패는 조용히 */ });
    }

    navigate(dest, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
