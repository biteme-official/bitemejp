/**
 * 한국어 리뷰 → 일본어 번역 (Claude API)
 *
 * 사용법:
 *   npx tsx scripts/translate-reviews.ts              # 전체
 *   npx tsx scripts/translate-reviews.ts 1000048009   # 특정 상품만
 *
 * 결과: data/reviews/{product_cd}.json 에 content_ja 필드 추가
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
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

const REVIEWS_DIR = join(__dirname, '..', 'data', 'reviews');
const BATCH_SIZE = 10;

interface Review {
  id: string;
  rating: number;
  name: string;
  content: string;
  content_ja?: string;
  date: string;
  images: string[];
}

async function translateBatch(reviews: Review[]): Promise<string[]> {
  const numbered = reviews
    .map((r, i) => `[${i + 1}]\n${r.content || '(내용 없음)'}`)
    .join('\n\n');

  const prompt = `あなたはペット用品専門の翻訳者です。以下の韓国語レビューを自然な日本語に翻訳してください。

翻訳の注意点：
- ペットの名前や愛称（例：감자→そのままカタカナで「カムジャ」等）は自然に処理
- 이모지（絵文字）はそのまま保持
- 口語的・感情的な表現は日本語らしい表現に
- 商品固有の韓国語名（例：헤잇미）はカタカナで「ヘイトミ」等に
- (내용 없음) はそのまま空文字で返す

${numbered}

以下のJSON形式のみで返答（他のテキスト不要）：
{"translations":["번역1","번역2",...]}`;

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
    const errText = await res.text();
    throw new Error(`Claude API 오류: ${res.status} - ${errText}`);
  }
  const data = await res.json();
  const text = data.content[0].text.trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`JSON 파싱 실패:\n${text}`);

  const parsed: { translations: string[] } = JSON.parse(match[0]);
  return parsed.translations;
}

async function translateFile(productCd: string) {
  const filePath = join(REVIEWS_DIR, `${productCd}.json`);
  if (!existsSync(filePath)) {
    console.log(`  [${productCd}] 파일 없음, 스킵`);
    return;
  }

  const data: { product_cd: string; scraped_at: string; total: number; reviews: Review[] } =
    JSON.parse(readFileSync(filePath, 'utf-8'));

  const untranslated = data.reviews.filter(r => !r.content_ja && r.content);
  if (untranslated.length === 0) {
    console.log(`  [${productCd}] 이미 번역 완료, 스킵`);
    return;
  }

  console.log(`  [${productCd}] ${untranslated.length}건 번역 시작...`);
  let done = 0;

  const reviewMap = new Map(data.reviews.map(r => [r.id, r]));

  for (let i = 0; i < untranslated.length; i += BATCH_SIZE) {
    const batch = untranslated.slice(i, i + BATCH_SIZE);
    try {
      const translations = await translateBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        const review = reviewMap.get(batch[j].id);
        if (review) {
          review.content_ja = translations[j] || '';
        }
      }
      done += batch.length;
      process.stdout.write(`\r    진행: ${done}/${untranslated.length}`);
    } catch (err) {
      console.error(`\n    배치 ${i / BATCH_SIZE + 1} 실패:`, err);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  data.reviews = [...reviewMap.values()];
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n    저장 완료`);
}

// 대상 파일 결정
const args = process.argv.slice(2);
let targets: string[] = [];

if (args.length > 0) {
  targets = args;
} else {
  targets = readdirSync(REVIEWS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

console.log(`번역 시작 (${targets.length}개 상품)...`);
for (const productCd of targets) {
  await translateFile(productCd);
}
console.log('\n✓ 번역 완료');
