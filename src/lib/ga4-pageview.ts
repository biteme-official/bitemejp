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

  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: window.location.origin + path,
    page_title: title || document.title,
    page_referrer: document.referrer || undefined,
    ...storedUtm,
  });
}
