/**
 * Shopify API 버전 — 저장소 전체에서 이 값 하나만 쓴다.
 *
 * 2026-09-17 실측: 상점이 지원하는 버전은 2025-10 · 2026-01 · 2026-04 · 2026-07.
 * 그동안 하드코딩돼 있던 2025-07 은 지원이 끝났고, Shopify 가 조용히 다른 버전으로
 * 처리해 주고 있었을 뿐이라 응답 필드가 바뀌어도 알 수 없었다.
 *
 * 올릴 때는 이 파일만 고친다. 긴급히 되돌려야 하면 배포 없이 환경변수
 * `SHOPIFY_API_VERSION` 으로 덮어쓸 수 있다(Storefront·Admin 공용).
 *
 * ⚠️ `api/` 안의 상대 import 는 반드시 `.js` 확장자를 붙인다 — 없으면 함수가
 * 로드 단계에서 죽고 화면엔 `Unknown error` 만 남는다(2026-08-21 장애).
 */
const DEFAULT_VERSION = '2026-01';

const fromEnv = (process.env.SHOPIFY_API_VERSION || '').trim();

export const SHOPIFY_API_VERSION: string =
  /^\d{4}-(01|04|07|10)$/.test(fromEnv) ? fromEnv : DEFAULT_VERSION;
