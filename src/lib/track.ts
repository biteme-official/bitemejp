function getSessionId(): string {
  const key = '_bm_sid';
  let sid = sessionStorage.getItem(key);
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(key, sid);
  }
  return sid;
}

export function track(eventType: string, eventLabel?: string, eventValue?: string): void {
  fetch('/api/track-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: eventType,
      event_label: eventLabel ?? null,
      event_value: eventValue ?? null,
      page_path: window.location.pathname + window.location.search,
      session_id: getSessionId(),
    }),
  }).catch(() => {});
}
