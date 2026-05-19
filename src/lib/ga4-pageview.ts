// GA4 SPA page_view tracker
// index.html sets send_page_view: false, so this is the single source of truth.

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

let lastTrackedPath = '';

// sessionStorage에 저장된 UTM 파라미터를 복원
// LINE 인앱 브라우저·Safari ITP로 쿠키가 제한될 때 소스 정보 보존용
function getStoredUtmParams(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem('_bm_utm');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Send a GA4 page_view event for SPA route changes.
 * Called on every route change including the initial load.
 */
export function trackPageView(path: string, title?: string) {
  if (path === lastTrackedPath) return;
  lastTrackedPath = path;

  if (typeof window === 'undefined' || !window.gtag) return;

  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const hasLiveUtm = ['utm_source', 'gclid'].some(k => params.get(k));

  // URL에 UTM이 없고 저장된 UTM이 있으면 복원 (인앱 브라우저 등 쿠키 제한 환경 대응)
  const storedUtm = !hasLiveUtm ? getStoredUtmParams() : {};

  // UTM이 URL에 있을 때는 쿼리스트링을 포함한 전체 URL을 page_location으로 전달
  // — Shopify 결제 복귀 시 return_to에 붙인 utm_source 등이 GA4 귀속에 반영되도록
  const pageLocation = hasLiveUtm
    ? window.location.href
    : window.location.origin + path;

  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: pageLocation,
    page_title: title || document.title,
    page_referrer: document.referrer || undefined,
    ...storedUtm,
  });
}
