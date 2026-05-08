/**
 * biteme.co.kr 전체 상품 목록 수집 (사이트맵 파싱 + 병렬 상품명 fetch)
 *
 * 사용법: npx tsx scripts/fetch-kr-products.ts
 * 결과:  data/kr-products.json
 *
 * 방식:
 *   1. sitemap.xml 파싱 → product_cd 목록 추출
 *   2. 각 상품 페이지 병렬 fetch → <title> 태그에서 상품명 추출
 *   3. JSON 저장
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const BASE_URL = 'https://www.biteme.co.kr';
const CONCURRENCY = 20;
const MAX_PRODUCTS = 5000; // co.jp 95개 매칭에 충분한 수량

export interface KrProduct {
  product_cd: string;
  name: string;
}

async function parseSitemap(): Promise<string[]> {
  console.log('사이트맵 파싱 중...');
  const res = await fetch(`${BASE_URL}/sitemap.xml`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
  });
  if (!res.ok) throw new Error(`sitemap fetch 실패: ${res.status}`);
  const xml = await res.text();

  const matches = xml.matchAll(/product_cd=(\d+)/g);
  const codes = [...new Set([...matches].map(m => m[1]))].slice(0, MAX_PRODUCTS);
  console.log(`  사이트맵에서 product_cd ${codes.length}개 추출 (상위 ${MAX_PRODUCTS}개 사용)`);
  return codes;
}

async function fetchProductName(productCd: string): Promise<KrProduct | null> {
  const url = `${BASE_URL}/shop/product/product_view?product_cd=${productCd}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // <title> 태그에서 상품명 추출
    // 보통 "상품명 | 바잇미" 또는 "상품명 - BITE ME" 형태
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (!titleMatch) return null;

    let name = titleMatch[1]
      .replace(/\s*[|｜-]\s*(바잇미|BITE\s*ME|biteme).*$/i, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();

    if (!name) return null;

    // og:title이 더 정확한 경우 사용
    const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (ogMatch) {
      const ogName = ogMatch[1]
        .replace(/\s*[|｜-]\s*(바잇미|BITE\s*ME|biteme).*$/i, '')
        .trim();
      if (ogName) name = ogName;
    }

    return { product_cd: productCd, name };
  } catch {
    return null;
  }
}

async function runWithConcurrency(
  items: string[],
  fn: (item: string) => Promise<KrProduct | null>,
  concurrency: number,
  outPath: string
): Promise<KrProduct[]> {
  const results: KrProduct[] = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const result = await fn(items[i]);
      if (result) results.push(result);

      if (i % 50 === 0) {
        process.stdout.write(`\r  진행: ${i}/${items.length} (성공: ${results.length})`);
      }
      // 500개마다 중간 저장
      if (results.length > 0 && results.length % 500 === 0) {
        writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`\n  완료: ${results.length}개 상품명 수집`);
  return results;
}

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const outPath = join(DATA_DIR, 'kr-products.json');
console.log('co.kr 상품 목록 수집 시작...');
const productCds = await parseSitemap();
const products = await runWithConcurrency(productCds, fetchProductName, CONCURRENCY, outPath);

writeFileSync(outPath, JSON.stringify(products, null, 2), 'utf-8');
console.log(`✓ 완료: ${products.length}개 → data/kr-products.json`);
