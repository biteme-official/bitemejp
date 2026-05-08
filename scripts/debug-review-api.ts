/**
 * 리뷰 API 응답 구조 디버깅용 스크립트
 * 사용법: npx tsx scripts/debug-review-api.ts
 */

import { chromium } from '@playwright/test';

const url = 'https://www.biteme.co.kr/shop/product/product_view?product_cd=1000048009';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
});
const page = await context.newPage();

page.on('response', async (response) => {
  const reqUrl = response.url();
  const ct = response.headers()['content-type'] || '';
  if (!ct.includes('application/json')) return;

  try {
    const json = await response.json();
    // 리뷰 관련 응답만 출력
    const text = JSON.stringify(json);
    if (text.includes('review') || text.includes('cre.ma') || text.includes('score') || text.includes('rating')) {
      console.log('\n=== API URL ===');
      console.log(reqUrl);
      console.log('\n=== 응답 최상위 키 ===');
      console.log(Object.keys(json));

      // 리뷰 배열 찾기
      const reviewArr = json.reviews || json.data || json.list || json.items || json.result;
      if (Array.isArray(reviewArr) && reviewArr.length > 0) {
        console.log('\n=== 리뷰 1개 전체 구조 ===');
        console.log(JSON.stringify(reviewArr[0], null, 2));
      } else {
        console.log('\n=== 전체 응답 (앞 2000자) ===');
        console.log(text.substring(0, 2000));
      }
    }
  } catch { /* ignore */ }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);

// 리뷰 탭 클릭
const selectors = ['a[href*="review"]', 'button:has-text("리뷰")', 'li:has-text("리뷰") a', 'a:has-text("리뷰")'];
for (const sel of selectors) {
  try {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 })) {
      await el.click();
      console.log(`\n리뷰 탭 클릭: ${sel}`);
      break;
    }
  } catch { /* 다음 */ }
}

await page.waitForTimeout(3000);
await browser.close();
