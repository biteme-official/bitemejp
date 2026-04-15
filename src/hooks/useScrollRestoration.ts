import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SCROLL_POSITIONS_KEY = 'scroll-positions';

export function saveScrollPosition(key: string) {
  const positions = JSON.parse(sessionStorage.getItem(SCROLL_POSITIONS_KEY) || '{}');
  positions[key] = window.scrollY;
  sessionStorage.setItem(SCROLL_POSITIONS_KEY, JSON.stringify(positions));
}

export function getScrollPosition(key: string): number {
  const positions = JSON.parse(sessionStorage.getItem(SCROLL_POSITIONS_KEY) || '{}');
  return positions[key] || 0;
}

export function clearScrollPosition(key: string) {
  const positions = JSON.parse(sessionStorage.getItem(SCROLL_POSITIONS_KEY) || '{}');
  delete positions[key];
  sessionStorage.setItem(SCROLL_POSITIONS_KEY, JSON.stringify(positions));
}

export function useScrollRestoration() {
  const location = useLocation();

  useEffect(() => {
    const savedPosition = getScrollPosition(location.pathname);
    if (savedPosition > 0) {
      // Small delay to ensure content is rendered
      setTimeout(() => {
        window.scrollTo(0, savedPosition);
        clearScrollPosition(location.pathname);
      }, 50);
    }
  }, [location.pathname]);
}
