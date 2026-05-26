/**
 * Shopify Customer Events Pixel — GA4 Purchase Tracker
 *
 * 설치: Shopify 어드민 → 설정 → Customer Events → 픽셀 추가 → 커스텀 픽셀
 *
 * 사전 준비:
 *   1. GA4 어드민 → 관리 → 데이터 스트림 → 스트림 선택
 *      → "Measurement Protocol API 보안 비밀" → 만들기 → 값 복사
 *   2. 아래 GA4_API_SECRET 에 붙여넣기
 */

const GA4_MEASUREMENT_ID = 'G-WLTZH90W2L';
const GA4_API_SECRET = 'REPLACE_WITH_API_SECRET'; // ← GA4에서 발급한 API 보안 비밀

analytics.subscribe('checkout_completed', async (event) => {
  const checkout = event.data.checkout;

  // 카트 생성 시 심어둔 GA4 어트리뷰션 데이터 읽기
  const attrs = {};
  (checkout.customAttributes || []).forEach(({ key, value }) => { attrs[key] = value; });

  const clientId = attrs['ga_client_id'];
  if (!clientId) return; // GA4 클라이언트 ID 없으면 추적 불가

  const items = (checkout.lineItems || []).map((item) => ({
    item_id: item.variant?.id ?? item.title,
    item_name: item.title,
    price: parseFloat(item.variant?.price?.amount ?? '0'),
    quantity: item.quantity,
  }));

  const params = {
    transaction_id: checkout.order?.id ?? checkout.token,
    value: parseFloat(checkout.totalPrice?.amount ?? '0'),
    currency: checkout.currencyCode,
    shipping: parseFloat(checkout.shippingLine?.price?.amount ?? '0'),
    items,
  };

  // GA4 세션과 연결 → 기존 세션의 소스/매체 어트리뷰션 유지
  if (attrs['ga_session_id']) params.session_id = attrs['ga_session_id'];
  if (attrs['ga_session_id']) params.engagement_time_msec = 1;

  // UTM 파라미터 (GA4 Measurement Protocol 캠페인 필드)
  if (attrs['utm_source'])   params.source = attrs['utm_source'];
  if (attrs['utm_medium'])   params.medium = attrs['utm_medium'];
  if (attrs['utm_campaign']) params.campaign = attrs['utm_campaign'];

  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${GA4_API_SECRET}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          events: [{ name: 'purchase', params }],
        }),
      }
    );
  } catch {
    // silent fail — 추적 실패가 체크아웃 UX에 영향을 주지 않도록
  }
});
