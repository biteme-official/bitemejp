/**
 * 전일자 신규 리뷰 증분 백업 + 일본어 번역
 *
 * - product-mapping.json 기반, kr_product_cd 있는 상품만 대상
 * - 지정 날짜(기본 어제, KST) 리뷰만 추출해 기존 파일에 추가
 * - ID 중복 제거 후 번역(content_ja 없는 것만) → 파일 저장
 *
 * 사용법:
 *   npx tsx scripts/sync-daily-reviews.ts                  # 어제 날짜
 *   npx tsx scripts/sync-daily-reviews.ts 2025-05-07       # 특정 날짜
 *   npx tsx scripts/sync-daily-reviews.ts --since 2025-05-09 # 해당 날짜 이후 전체 (백필)
 */

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const DATA_DIR = join(__dirname, '..', 'data');
const REVIEWS_DIR = join(DATA_DIR, 'reviews');
const CREMA_HOST = 'review6.cre.ma';
const SHOP_CODE = 'biteme.co.kr';
const WIDGET_ID = '25';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// 상품당 페이징 상한 (페이지당 5건) — 무한 루프 방지
const MAX_PAGES = 300;
// 백필(--since) 시 상품당 수집 상한. trim-reviews.ts 가 50건으로 자르므로
// 그보다 조금만 더 모으면 충분하다 (불필요한 번역 비용 방지).
const BACKFILL_MAX_PER_PRODUCT = 60;

interface ScrapedReview {
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
  reviews: ScrapedReview[];
}

// KST 기준 어제 날짜 (YYYY-MM-DD)
function getTargetDate(arg?: string): string {
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  // KST = UTC+9
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCDate(kst.getUTCDate() - 1);
  return kst.toISOString().slice(0, 10);
}

function dateOf(dateStr: string): string {
  // created_at이 "2025-05-07T10:30:00+09:00" 또는 "2025-05-07" 형식
  return dateStr.slice(0, 10);
}

async function getCremaToken(productCd: string): Promise<string | null> {
  const url = `https://www.biteme.co.kr/shop/product/product_view?product_cd=${productCd}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  let token: string | null = null;
  page.on('request', (req) => {
    if (req.url().includes(CREMA_HOST)) {
      const match = req.url().match(/secure_device_token=([^&]+)/);
      if (match) token = match[1];
    }
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  } finally {
    await browser.close();
  }
  return token;
}

function parseReview(item: Record<string, unknown>): ScrapedReview | null {
  const id = String(item.id || '');
  if (!id) return null;
  const rating = Number(item.score || 0);
  const name = String(item.user_display_name || '').trim();
  const content = String(item.filtered_message || item.message || '').trim();
  const date = String(item.created_at || '').trim();
  const images: string[] = [];
  const imgList = item.images as Record<string, unknown>[] | undefined;
  if (Array.isArray(imgList)) {
    for (const img of imgList) {
      const src = String(img.url || img.gallery_url || '');
      if (src) images.push(src);
    }
  }
  return { id, rating, name, content, date, images };
}

/**
 * sinceDate 이후 리뷰 수집 (최신순 정렬이라 조건 충족 전까지만 페이징)
 * exactDate 를 주면 해당 날짜 리뷰만 남긴다.
 *
 * ⚠️ sort=recent 필수 — 미지정 시 API 기본 정렬이 최신순이 아니라
 *    (2021~2022년 리뷰가 1페이지에 섞여 옴) 첫 페이지에서 페이징이 끊긴다.
 */
async function fetchReviewsSince(
  token: string,
  productCd: string,
  sinceDate: string,
  exactDate?: string,
  maxItems?: number
): Promise<ScrapedReview[]> {
  const results: ScrapedReview[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const params = new URLSearchParams({
      secure_device_token: token,
      product_code: productCd,
      widget_id: WIDGET_ID,
      page: String(page),
      sort: 'recent',
      fields: 'reviews.evaluation_properties',
    });

    const res = await fetch(
      `https://${CREMA_HOST}/api/${SHOP_CODE}/reviews?${params}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) break;

    const data = await res.json();
    const rawList: Record<string, unknown>[] = data.reviews || [];
    if (rawList.length === 0) break;

    let stop = false;
    for (const item of rawList) {
      const review = parseReview(item);
      if (!review) continue;
      const d = dateOf(review.date);
      if (d < sinceDate) {
        // 기준일보다 오래된 리뷰 → 이후 페이지도 불필요
        stop = true;
        break;
      }
      // exactDate 지정 시 그 날짜만, 아니면 sinceDate 이후 전부
      if (!exactDate || d === exactDate) results.push(review);
      // 최신순이므로 상한에 닿으면 나머지는 어차피 트림 대상
      if (maxItems && results.length >= maxItems) {
        stop = true;
        break;
      }
    }

    if (stop) break;

    const pagy = data.pagy as Record<string, unknown> | undefined;
    if (!pagy?.next) break;

    page++;
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}

// ── 번역 ──────────────────────────────────────────────
async function translateBatch(reviews: ScrapedReview[]): Promise<string[]> {
  const numbered = reviews
    .map((r, i) => `[${i + 1}]\n${r.content || '(내용 없음)'}`)
    .join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `以下の韓国語レビューを自然な日本語に翻訳してください。番号付きで同じ形式で返してください。翻訳のみ返してください。

${numbered}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const json = await res.json();
  const text: string = json.content?.[0]?.text || '';

  const translations: string[] = [];
  const parts = text.split(/\[(\d+)\]/);
  for (let i = 1; i < parts.length; i += 2) {
    translations[Number(parts[i]) - 1] = parts[i + 1]?.trim() || '';
  }
  return translations;
}

async function translateNewReviews(reviews: ScrapedReview[]): Promise<void> {
  if (!ANTHROPIC_API_KEY) {
    console.log('  ⚠ ANTHROPIC_API_KEY 없음 — 번역 스킵');
    return;
  }
  const untranslated = reviews.filter((r) => !r.content_ja && r.content);
  if (untranslated.length === 0) return;

  const BATCH = 10;
  for (let i = 0; i < untranslated.length; i += BATCH) {
    const batch = untranslated.slice(i, i + BATCH);
    try {
      const translations = await translateBatch(batch);
      batch.forEach((r, idx) => {
        if (translations[idx]) r.content_ja = translations[idx];
      });
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.log(`  ⚠ 번역 실패 (배치 ${i / BATCH + 1}): ${e}`);
    }
  }
}

// ── 메인 ──────────────────────────────────────────────
// --since YYYY-MM-DD → 해당 날짜 이후 전체 수집 (백필). 없으면 단일 날짜 모드.
const sinceIdx = process.argv.indexOf('--since');
const sinceArg = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;

if (sinceArg && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) {
  console.error('❌ --since 형식이 잘못됨 (YYYY-MM-DD). 종료합니다.');
  process.exit(1);
}

const targetDate = sinceArg ? undefined : getTargetDate(process.argv[2]);
const sinceDate = sinceArg ?? targetDate!;
console.log(
  sinceArg ? `\n백필 모드: ${sinceArg} 이후 전체 (KST)\n` : `\n대상 날짜: ${targetDate} (KST)\n`
);

const mappingPath = join(DATA_DIR, 'product-mapping.json');
const mapping: { kr_product_cd: string | null; confidence: string }[] =
  JSON.parse(readFileSync(mappingPath, 'utf-8'));

const targets = mapping
  .filter((m) => m.kr_product_cd && m.confidence !== 'no_match')
  .map((m) => m.kr_product_cd!);

console.log(`매핑된 상품 ${targets.length}개 대상\n토큰 획득 중...`);
const token = await getCremaToken(targets[0]);
if (!token) {
  console.error('❌ Crema 토큰 획득 실패. 종료합니다.');
  process.exit(1);
}
console.log('토큰 획득 완료\n');

let totalNew = 0;

for (const productCd of targets) {
  const filePath = join(REVIEWS_DIR, `${productCd}.json`);
  const newReviews = await fetchReviewsSince(
    token,
    productCd,
    sinceDate,
    targetDate,
    sinceArg ? BACKFILL_MAX_PER_PRODUCT : undefined
  );

  if (newReviews.length === 0) continue;

  // 기존 파일 로드 또는 초기화
  let data: ProductReviewData;
  if (existsSync(filePath)) {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } else {
    data = { product_cd: productCd, scraped_at: new Date().toISOString(), total: 0, reviews: [] };
  }

  // 중복 제거 후 신규만 추가
  const existingIds = new Set(data.reviews.map((r) => r.id));
  const toAdd = newReviews.filter((r) => !existingIds.has(r.id));

  if (toAdd.length === 0) {
    console.log(`  [${productCd}] 신규 없음 (${newReviews.length}건 모두 중복)`);
    continue;
  }

  // 번역
  process.stdout.write(`  [${productCd}] ${toAdd.length}건 신규 → 번역 중...`);
  await translateNewReviews(toAdd);
  console.log(' 완료');

  // 최신 리뷰를 앞에 추가
  data.reviews = [...toAdd, ...data.reviews];
  data.total = data.reviews.length;
  data.scraped_at = new Date().toISOString();

  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  totalNew += toAdd.length;
  console.log(`  [${productCd}] +${toAdd.length}건 저장 (누적 ${data.total}건)`);
}

console.log(
  `\n✓ 완료: ${totalNew}건 신규 추가 (${targetDate ?? `${sinceDate} 이후`})`
);
