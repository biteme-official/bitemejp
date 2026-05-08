import type { Connect } from 'vite';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');

export function krReviewsMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url?.startsWith('/api/kr-reviews')) return next();

    const url = new URL(req.url, 'http://localhost');
    const shopifyProductId = url.searchParams.get('shopify_product_id') || '';
    const numericId = shopifyProductId.split('/').pop()!;

    res.setHeader('Content-Type', 'application/json');

    const mappingPath = join(DATA_DIR, 'product-mapping.json');
    if (!existsSync(mappingPath)) {
      res.end(JSON.stringify({ reviews: [], total: 0 }));
      return;
    }

    const mapping: { jp_numeric_id: string; kr_product_cd: string | null; confidence: string }[] =
      JSON.parse(readFileSync(mappingPath, 'utf-8'));

    const match = mapping.find(m => m.jp_numeric_id === numericId);
    if (!match?.kr_product_cd) {
      res.end(JSON.stringify({ reviews: [], total: 0 }));
      return;
    }

    const reviewPath = join(DATA_DIR, 'reviews', `${match.kr_product_cd}.json`);
    if (!existsSync(reviewPath)) {
      res.end(JSON.stringify({ reviews: [], total: 0 }));
      return;
    }

    const reviewData = JSON.parse(readFileSync(reviewPath, 'utf-8'));
    res.end(JSON.stringify({ reviews: reviewData.reviews, total: reviewData.total }));
  };
}
