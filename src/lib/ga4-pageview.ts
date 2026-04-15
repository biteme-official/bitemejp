// GA4 SPA page_view tracker
// GA4's automatic page_view only fires on initial full page load.
// For SPA route changes, we must manually send page_view events
// so that every subsequent event inherits the correct page context
// and user source/medium attribution is preserved.

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

let lastTrackedPath = '';

/**
 * Send a GA4 page_view event for SPA route changes.
 * Should be called on every route change BEFORE any other GA4 events.
 */
export function trackPageView(path: string, title?: string) {
  // Deduplicate: don't fire if same path (e.g. re-renders)
  if (path === lastTrackedPath) return;
  lastTrackedPath = path;

  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', 'page_view', {
      page_path: path,
      page_location: window.location.origin + path,
      page_title: title || document.title,
    });
  }
}
