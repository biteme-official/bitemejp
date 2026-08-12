import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP_DOMAIN = 'hihtsp-0m.myshopify.com';
const PRIVATE_TOKEN = process.env.JUDGEME_PRIVATE_TOKEN || '';
const BASE_URL = 'https://judge.me/api/v1';
// Judge.me 한 페이지 최대치. 상품당 리뷰가 이보다 많으면 최신 100건만 노출한다.
const PER_PAGE = 100;

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

/** Judge.me 원본 리뷰 (필요한 필드만) */
interface JudgemeReview {
  id: number;
  rating: number;
  title?: string | null;
  body?: string | null;
  created_at?: string | null;
  published?: boolean;
  hidden?: boolean;
  verified?: string | null;
  reviewer?: { name?: string | null } | null;
  pictures?: { urls?: Record<string, string> | null }[] | null;
}

/** 프론트로 내보내는 형태 — kr-reviews 응답과 동일한 스키마 */
interface PublicReview {
  id: string;
  rating: number;
  name: string;
  content: string;
  date: string;
  images: string[];
  source: 'judgeme';
  verified: boolean;
}

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin);
  return isAllowed ? origin : ALLOWED_ORIGINS[0];
}

/**
 * 공개 가능한 필드만 남긴다.
 * ⚠️ Judge.me 원본에는 리뷰어 이메일·전화번호·마케팅 수신여부가 들어 있으므로
 *    절대 그대로 내보내지 말 것.
 */
function toPublicReview(r: JudgemeReview): PublicReview {
  const title = (r.title || '').trim();
  const body = (r.body || '').trim();
  const images = (r.pictures || [])
    .map((p) => p.urls?.compact || p.urls?.original || '')
    .filter(Boolean);

  return {
    id: `jm-${r.id}`,
    rating: Number(r.rating) || 0,
    name: (r.reviewer?.name || '').trim(),
    content: [title, body].filter(Boolean).join('\n'),
    date: r.created_at || '',
    images,
    source: 'judgeme',
    verified: r.verified === 'buyer',
  };
}

/** Shopify 상품 ID → Judge.me 내부 상품 ID (람다 재사용 구간 동안 캐시) */
const productIdCache = new Map<string, number | null>();

async function resolveJudgemeProductId(externalId: string): Promise<number | null> {
  const cached = productIdCache.get(externalId);
  if (cached !== undefined) return cached;

  const params = new URLSearchParams({
    api_token: PRIVATE_TOKEN,
    shop_domain: SHOP_DOMAIN,
    external_id: externalId,
  });
  const res = await fetch(`${BASE_URL}/products/-1?${params}`);
  if (!res.ok) {
    // 미등록 상품(404)만 캐시. 5xx 는 다음 요청에서 재시도.
    if (res.status === 404) productIdCache.set(externalId, null);
    return null;
  }
  const data = (await res.json()) as { product?: { id?: number } };
  const id = data.product?.id ?? null;
  productIdCache.set(externalId, id);
  return id;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOrigin = getCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { shopify_product_id } = req.query;
  if (!shopify_product_id) {
    return res.status(400).json({ error: 'shopify_product_id is required' });
  }

  // 토큰 미설정 시에도 상세 페이지가 깨지지 않도록 빈 목록으로 응답
  if (!PRIVATE_TOKEN) {
    return res.status(200).json({ reviews: [], total: 0, configured: false });
  }

  const numericId = String(shopify_product_id).split('/').pop()!;

  let raw: JudgemeReview[];
  try {
    // 1단계: Shopify 상품 ID → Judge.me 내부 상품 ID
    // ⚠️ /reviews 는 product_id(내부 ID)로만 필터된다. product_external_id 를 넘기면
    //    조용히 무시되고 "샵 전체 리뷰"가 돌아오므로 반드시 이 변환을 거칠 것.
    const productId = await resolveJudgemeProductId(numericId);
    if (!productId) {
      return res.status(200).json({ reviews: [], total: 0 });
    }

    // 2단계: 해당 상품의 리뷰만 조회
    const params = new URLSearchParams({
      api_token: PRIVATE_TOKEN,
      shop_domain: SHOP_DOMAIN,
      product_id: String(productId),
      per_page: String(PER_PAGE),
      page: '1',
    });
    const jRes = await fetch(`${BASE_URL}/reviews?${params}`);
    if (!jRes.ok) {
      return res.status(200).json({ reviews: [], total: 0, error: `judgeme_${jRes.status}` });
    }
    const data = (await jRes.json()) as { reviews?: JudgemeReview[] };
    raw = data.reviews || [];
  } catch {
    return res.status(200).json({ reviews: [], total: 0, error: 'judgeme_unreachable' });
  }

  // 미승인·숨김 리뷰는 제외 (Judge.me 관리자에서 모더레이션한 결과를 존중)
  const reviews = raw
    .filter((r) => r.published !== false && r.hidden !== true)
    .map(toPublicReview)
    .sort((a, b) => b.date.localeCompare(a.date));

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
  return res.status(200).json({ reviews, total: reviews.length });
}
