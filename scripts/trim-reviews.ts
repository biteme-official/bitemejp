/**
 * 상품당 리뷰 최대 50개로 트림 (포토리뷰 우선)
 * 기존 번역(content_ja)은 보존
 *
 * 사용법:
 *   npx tsx scripts/trim-reviews.ts          # 전체
 *   npx tsx scripts/trim-reviews.ts 1000055147  # 특정 상품만
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEWS_DIR = join(__dirname, '..', 'data', 'reviews');
const MAX = 50;

interface Review {
  id: string;
  rating: number;
  name: string;
  content: string;
  content_ja?: string;
  date: string;
  images: string[];
}

interface ProductReviewData {
  product_cd: string;
  scraped_at: string;
  total: number;
  reviews: Review[];
}

const args = process.argv.slice(2);
const targets = args.length > 0
  ? args.map(a => `${a}.json`)
  : readdirSync(REVIEWS_DIR).filter(f => f.endsWith('.json'));

let trimmed = 0;
let skipped = 0;

for (const file of targets) {
  const path = join(REVIEWS_DIR, file);
  const data: ProductReviewData = JSON.parse(readFileSync(path, 'utf-8'));

  if (data.reviews.length <= MAX) {
    skipped++;
    continue;
  }

  // 포토리뷰 우선, 동일 조건 내에서 최신순
  const sorted = [...data.reviews].sort((a, b) => {
    const aPhoto = a.images.length > 0 ? 1 : 0;
    const bPhoto = b.images.length > 0 ? 1 : 0;
    if (bPhoto !== aPhoto) return bPhoto - aPhoto;
    return b.date.localeCompare(a.date);
  });

  data.reviews = sorted.slice(0, MAX);
  data.total = data.reviews.length;

  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  trimmed++;
  console.log(`  [${data.product_cd}] ${sorted.length}건 → ${MAX}건 (포토 ${data.reviews.filter(r => r.images.length > 0).length}건)`);
}

console.log(`\n✓ 완료: ${trimmed}개 트림, ${skipped}개 스킵 (이미 ${MAX}개 이하)`);
