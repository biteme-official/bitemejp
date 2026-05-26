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
const GA4_API_SECRET = 'REPLACE_WITH_API_SECRET';

analytics.subscribe('checkout_completed', (event) => {
  const checkout = event.data.checkout;

  const attrs = Object.fromEntries(
    (checkout.customAttributes || []).map(({ key, value }) => [key, value])
  );

  const clientId = attrs.ga_client_id;
  if (!clientId) return;

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
    ...(attrs.ga_session_id && { session_id: attrs.ga_session_id, engagement_time_msec: 1 }),
    ...(attrs.utm_source   && { source: attrs.utm_source }),
    ...(attrs.utm_medium   && { medium: attrs.utm_medium }),
    ...(attrs.utm_campaign && { campaign: attrs.utm_campaign }),
  };

  navigator.sendBeacon(
    `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${GA4_API_SECRET}`,
    JSON.stringify({ client_id: clientId, events: [{ name: 'purchase', params }] })
  );
});
