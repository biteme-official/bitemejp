import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

interface ProductMapping {
  jp_numeric_id: string;
  kr_product_cd: string | null;
  confidence: string;
}

interface ScrapedReview {
  id: string;
  rating: number;
  name: string;
  content: string;
  date: string;
  images: string[];
}

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin);
  return isAllowed ? origin : ALLOWED_ORIGINS[0];
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
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

  const numericId = String(shopify_product_id).split('/').pop()!;

  // 매핑에서 kr_product_cd 조회
  const mapping = loadJson<ProductMapping[]>(join(DATA_DIR, 'product-mapping.json'));
  if (!mapping) {
    return res.status(200).json({ reviews: [], total: 0 });
  }

  const match = mapping.find(m => m.jp_numeric_id === numericId);
  if (!match?.kr_product_cd) {
    return res.status(200).json({ reviews: [], total: 0 });
  }

  // 리뷰 파일 읽기
  const reviewData = loadJson<{ reviews: ScrapedReview[]; total: number }>(
    join(DATA_DIR, 'reviews', `${match.kr_product_cd}.json`)
  );

  if (!reviewData) {
    return res.status(200).json({ reviews: [], total: 0 });
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  return res.status(200).json({
    reviews: reviewData.reviews,
    total: reviewData.total,
    kr_product_cd: match.kr_product_cd,
    confidence: match.confidence,
  });
}
