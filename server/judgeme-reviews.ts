import type { Connect } from 'vite';

// 개발 서버용 — api/judgeme-reviews.ts 와 동일한 응답을 돌려준다
// (kr-reviews 와 같은 구성: api/ 는 Vercel, server/ 는 vite dev)

const SHOP_DOMAIN = 'hihtsp-0m.myshopify.com';
const BASE_URL = 'https://judge.me/api/v1';
const PER_PAGE = 100;

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

/** ⚠️ 원본에는 리뷰어 이메일·전화번호가 있으므로 공개 필드만 남긴다 */
function toPublicReview(r: JudgemeReview) {
  const title = (r.title || '').trim();
  const body = (r.body || '').trim();
  return {
    id: `jm-${r.id}`,
    rating: Number(r.rating) || 0,
    name: (r.reviewer?.name || '').trim(),
    content: [title, body].filter(Boolean).join('\n'),
    date: r.created_at || '',
    images: (r.pictures || [])
      .map((p) => p.urls?.compact || p.urls?.original || '')
      .filter(Boolean),
    source: 'judgeme' as const,
    verified: r.verified === 'buyer',
  };
}

export function judgemeReviewsMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/judgeme-reviews')) return next();

    res.setHeader('Content-Type', 'application/json');

    const token = process.env.JUDGEME_PRIVATE_TOKEN || '';
    if (!token) {
      res.end(JSON.stringify({ reviews: [], total: 0, configured: false }));
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const numericId = (url.searchParams.get('shopify_product_id') || '').split('/').pop() || '';
    if (!numericId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'shopify_product_id is required' }));
      return;
    }

    try {
      // /reviews 는 Judge.me 내부 product_id 로만 필터된다 (external id 는 무시됨)
      const pRes = await fetch(
        `${BASE_URL}/products/-1?${new URLSearchParams({
          api_token: token,
          shop_domain: SHOP_DOMAIN,
          external_id: numericId,
        })}`
      );
      const productId = pRes.ok
        ? ((await pRes.json()) as { product?: { id?: number } }).product?.id
        : null;
      if (!productId) {
        res.end(JSON.stringify({ reviews: [], total: 0 }));
        return;
      }

      const params = new URLSearchParams({
        api_token: token,
        shop_domain: SHOP_DOMAIN,
        product_id: String(productId),
        per_page: String(PER_PAGE),
        page: '1',
      });
      const jRes = await fetch(`${BASE_URL}/reviews?${params}`);
      if (!jRes.ok) {
        res.end(JSON.stringify({ reviews: [], total: 0, error: `judgeme_${jRes.status}` }));
        return;
      }
      const data = (await jRes.json()) as { reviews?: JudgemeReview[] };
      const reviews = (data.reviews || [])
        .filter((r) => r.published !== false && r.hidden !== true)
        .map(toPublicReview)
        .sort((a, b) => b.date.localeCompare(a.date));
      res.end(JSON.stringify({ reviews, total: reviews.length }));
    } catch {
      res.end(JSON.stringify({ reviews: [], total: 0, error: 'judgeme_unreachable' }));
    }
  };
}
