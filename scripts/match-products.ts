/**
 * Claude API로 co.jp(일본어) ↔ co.kr(한국어) 상품 매칭
 *
 * 방식:
 *   1. jp 상품명 전체를 Claude로 한국어 번역 (API 1회)
 *   2. 번역된 한국어로 kr 상품과 n-gram 유사도 계산 (API 없이)
 *   3. 결과 저장
 *
 * 사용법: npx tsx scripts/match-products.ts
 * 결과:   data/product-mapping.json
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('❌ .env에 ANTHROPIC_API_KEY가 없습니다.');
  process.exit(1);
}

const DATA_DIR = join(__dirname, '..', 'data');

export interface ProductMapping {
  jp_numeric_id: string;
  jp_title: string;
  jp_handle: string;
  kr_product_cd: string | null;
  kr_name: string | null;
  confidence: 'high' | 'medium' | 'low' | 'no_match';
}

interface JpProduct { id: string; numericId: string; title: string; handle: string }
interface KrProduct { product_cd: string; name: string }

function loadJson<T>(filename: string): T {
  const path = join(DATA_DIR, filename);
  if (!existsSync(path)) throw new Error(`파일 없음: ${path}\n먼저 fetch 스크립트를 실행하세요.`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// 텍스트 정규화: 한글+영숫자만 남김
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^가-힣a-z0-9]/g, '');
}

// 문자 bigram 유사도 (Jaccard)
function bigramSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(na);
  const setB = bigrams(nb);
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// jp 상품명 → 한국어 번역 (API 1회)
async function translateJpTitles(jpProducts: JpProduct[]): Promise<Map<string, string>> {
  const list = jpProducts.map((p, i) => `${i + 1}. [${p.numericId}] ${p.title}`).join('\n');

  const prompt = `아래 일본어 펫용품 상품명을 한국어로 번역하세요.
브랜드명·시리즈명은 한국어 발음(음차)으로, 제품 종류는 자연스러운 한국어로 번역하세요.

${list}

JSON 형식만 반환 (다른 텍스트 없이):
{"translations":{"numericId":"한국어번역",...}}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API 오류: ${res.status} ${err}`);
  }

  const data = await res.json();
  const text = data.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`JSON 파싱 실패:\n${text}`);

  const parsed: { translations: Record<string, string> } = JSON.parse(match[0]);
  return new Map(Object.entries(parsed.translations));
}

// 한국어 번역명으로 kr 상품 매칭
function findBestMatch(
  krTitle: string,
  krProducts: KrProduct[]
): { product: KrProduct; score: number } | null {
  let best: { product: KrProduct; score: number } | null = null;
  for (const kr of krProducts) {
    const score = bigramSimilarity(krTitle, kr.name);
    if (!best || score > best.score) {
      best = { product: kr, score };
    }
  }
  return best;
}

function scoreToConfidence(score: number): ProductMapping['confidence'] {
  if (score >= 0.5) return 'high';
  if (score >= 0.35) return 'medium';
  if (score >= 0.2) return 'low';
  return 'no_match';
}

console.log('상품 매칭 시작...');
const jpProducts: JpProduct[] = loadJson('jp-products.json');
const allKrProducts: KrProduct[] = loadJson('kr-products.json');

// 바잇미 / 컴피라비올리 / 애플사이다레시피 브랜드만 사용
const krProducts = allKrProducts.filter(p =>
  p.name.includes('바잇미') ||
  p.name.toLowerCase().includes('bite me') ||
  p.name.includes('컴피라비올리') ||
  p.name.toLowerCase().includes('comfyravioli') ||
  p.name.includes('애플사이다레시피') ||
  p.name.toLowerCase().includes('apple cider recipe')
);
console.log(`  co.jp: ${jpProducts.length}개, co.kr (브랜드 필터): ${krProducts.length}개`);

console.log('  jp 상품명 한국어 번역 중... (API 1회 호출)');
const translations = await translateJpTitles(jpProducts);
console.log(`  번역 완료: ${translations.size}개`);

console.log('  유사도 매칭 중...');
const allMappings: ProductMapping[] = [];

for (const jp of jpProducts) {
  const krTitle = translations.get(jp.numericId) ?? jp.title;
  const match = findBestMatch(krTitle, krProducts);

  const confidence = match ? scoreToConfidence(match.score) : 'no_match';

  allMappings.push({
    jp_numeric_id: jp.numericId,
    jp_title: jp.title,
    jp_handle: jp.handle,
    kr_product_cd: confidence !== 'no_match' ? match!.product.product_cd : null,
    kr_name: confidence !== 'no_match' ? match!.product.name : null,
    confidence,
  });
}

// 2차 패스: no_match/low 항목을 Claude + 바잇미 171개로 재매칭
const bitemKr = krProducts; // 이미 3개 브랜드로 필터됨
const retryTargets = allMappings.filter(m => m.confidence === 'no_match' || m.confidence === 'low');

if (retryTargets.length > 0 && bitemKr.length > 0) {
  console.log(`\n  2차 패스: ${retryTargets.length}개 항목을 Claude + 바잇미 ${bitemKr.length}개로 재매칭...`);

  const krListText = bitemKr.map(p => `${p.product_cd}\t${p.name}`).join('\n');
  const jpListText = retryTargets.map((m, i) => `${i + 1}. [${m.jp_numeric_id}] ${m.jp_title}`).join('\n');

  const prompt = `당신은 한국어-일본어 펫용품 상품 매칭 전문가입니다.
아래 [일본 상품]을 [한국 바잇미 상품]에서 가장 잘 맞는 상품과 연결해주세요.

매칭 기준:
- 브랜드, 제품 종류, 용량/크기가 동일하거나 매우 유사한 것
- 매칭 불가 시 "NO_MATCH"

[일본 상품]
${jpListText}

[한국 바잇미 상품] (product_cd\t상품명)
${krListText}

JSON 배열만 반환:
[{"jp_numeric_id":"숫자","kr_product_cd":"코드 또는 null","confidence":"high|medium|low|no_match"}]`;

  const res2 = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (res2.ok) {
    const data2 = await res2.json();
    const text2 = data2.content[0].text.trim();
    const match2 = text2.match(/\[[\s\S]*\]/);
    if (match2) {
      const raw2: { jp_numeric_id: string; kr_product_cd: string | null; confidence: string }[] =
        JSON.parse(match2[0]);
      const krMap = new Map(bitemKr.map(p => [p.product_cd, p.name]));

      for (const item of raw2) {
        const mapping = allMappings.find(m => m.jp_numeric_id === item.jp_numeric_id);
        if (!mapping) continue;
        const conf = item.confidence as ProductMapping['confidence'];
        if (conf !== 'no_match' && item.kr_product_cd) {
          mapping.kr_product_cd = item.kr_product_cd;
          mapping.kr_name = krMap.get(item.kr_product_cd) ?? null;
          mapping.confidence = conf;
        }
      }
      console.log('  2차 패스 완료');
    }
  } else {
    console.error('  2차 패스 API 오류:', res2.status);
  }
}

const matched = allMappings.filter(m => m.confidence !== 'no_match');
console.log(`\n최종 매칭 결과:`);
console.log(`  high:     ${allMappings.filter(m => m.confidence === 'high').length}개`);
console.log(`  medium:   ${allMappings.filter(m => m.confidence === 'medium').length}개`);
console.log(`  low:      ${allMappings.filter(m => m.confidence === 'low').length}개`);
console.log(`  no_match: ${allMappings.filter(m => m.confidence === 'no_match').length}개`);
console.log(`  총 매칭:  ${matched.length}/${allMappings.length}개`);

console.log('\n매칭 샘플 (high/medium):');
allMappings
  .filter(m => m.confidence === 'high' || m.confidence === 'medium')
  .slice(0, 15)
  .forEach(m => console.log(`  [${m.confidence}] ${m.jp_title} → ${m.kr_name}`));

writeFileSync(
  join(DATA_DIR, 'product-mapping.json'),
  JSON.stringify(allMappings, null, 2),
  'utf-8'
);
console.log(`\n✓ 완료 → data/product-mapping.json`);
