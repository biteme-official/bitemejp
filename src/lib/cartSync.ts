import { useAuthStore } from '@/stores/authStore';
import type { CartItem } from '@/stores/cartStore';

/**
 * 로그인 고객의 장바구니 스냅샷을 서버에 남긴다.
 *
 * Shopify 의 이탈 결제(abandoned checkout)는 **결제창까지 들어간 사람**만 기록한다.
 * 담기만 하고 결제창에 안 가면 우리 쪽에 흔적이 없어서, 장바구니 이탈 저니가 그 사람을
 * 볼 수 없었다. 2026-09-04 담기 이벤트 때 담기는 293 → 1,341 로 뛰었는데 결제창 이탈은
 * 15 → 16 이었다 — 담기 단계가 통째로 사각지대였다.
 *
 * 그래서 카트가 바뀔 때마다 여기서 스냅샷을 던지고 `cart_add` 저니가 그걸 읽는다.
 *
 * · 비로그인 방문자는 보내지 않는다 (보낼 곳이 없다).
 * · 서버는 서명된 `lineSessionToken` 에서만 LINE userId 를 꺼낸다 — 여기서 userId 를
 *   실어 보내지 않는 이유다.
 * · 증정품 라인은 뺀다. 고객이 담은 것이 아니라 임계값을 넘겨서 우리가 붙인 것이라,
 *   문안에 「うちわ をお預かりしています」가 나가면 이상하다.
 */

/** 담기 한 번에 한 통씩 던지지 않도록 묶는 간격. 수량 버튼 연타를 한 번으로 만든다. */
const DEBOUNCE_MS = 4000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: CartItem[] | null = null;

function post(items: CartItem[]): void {
  const token = useAuthStore.getState().user?.lineSessionToken;
  if (!token) return;

  const payload = items
    .filter(i => !i.isGift)
    .map(i => ({
      productId: i.product?.node?.id,
      variantId: i.variantId,
      quantity: i.quantity,
      title: i.product?.node?.title ?? '',
    }))
    .filter(i => !!i.productId && !!i.variantId);

  // 빈 카트도 보낸다 — "비웠다"가 저니를 멈추는 신호다.
  fetch('/api/line-cart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineSessionToken: token, items: payload }),
  }).catch(() => {});
}

export function syncCartSnapshot(items: CartItem[]): void {
  if (!useAuthStore.getState().user?.lineSessionToken) return;
  pending = items;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const snapshot = pending;
    pending = null;
    if (snapshot) post(snapshot);
  }, DEBOUNCE_MS);
}

/** 탭을 닫아도 마지막 상태는 남겨야 한다 — 담고 바로 나가는 사람이 이 저니의 핵심 대상이다. */
export function flushCartSnapshot(): void {
  if (!timer || !pending) return;
  clearTimeout(timer);
  timer = null;
  const snapshot = pending;
  pending = null;
  post(snapshot);
}

if (typeof window !== 'undefined') {
  // pagehide 는 뒤로가기 캐시·탭 종료 양쪽에서 뜬다. visibilitychange 는 모바일에서
  // 앱 전환만 해도 뜨는데, 그때도 카트는 이미 확정이라 보내도 손해가 없다.
  window.addEventListener('pagehide', flushCartSnapshot);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushCartSnapshot();
  });
}
