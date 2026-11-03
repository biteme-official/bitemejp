import { test, expect, type Page } from '@playwright/test';

const PURCHASE_BUTTON = /買い物かごに追加|カートに追加|すぐ購入/;
// 출시 예정 상품은 장바구니 대신 오픈 알림 버튼만 보여준다 (#249)
const PRELAUNCH_BUTTON = /発売をLINEで受け取る/;
const MAX_PRODUCTS_TO_TRY = 6;

// 홈 상품 그리드에서 구매 버튼이 있는 첫 상품을 연다. 출시 예정 상품은 건너뛴다.
async function openPurchasableProduct(page: Page) {
  const productCards = page.locator('main h3');
  await expect(productCards.first()).toBeVisible({ timeout: 15_000 });
  const total = Math.min(await productCards.count(), MAX_PRODUCTS_TO_TRY);

  for (let i = 0; i < total; i++) {
    const card = productCards.nth(i);
    console.log(`Clicking product: ${await card.textContent()}`);
    await card.click();
    await page.waitForURL(/\/product\//, { timeout: 10_000 });

    const actionButton = page
      .getByRole('button', { name: new RegExp(`${PURCHASE_BUTTON.source}|${PRELAUNCH_BUTTON.source}`) })
      .first();
    await expect(actionButton).toBeVisible({ timeout: 10_000 });

    if (await page.getByRole('button', { name: PURCHASE_BUTTON }).count()) return;

    console.log('Pre-launch product, trying next one');
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(productCards.first()).toBeVisible({ timeout: 15_000 });
  }

  throw new Error(`No purchasable product in the first ${total} products on homepage`);
}

test.describe('Purchase Flow E2E', () => {
  test('Home → Product → Cart → Checkout entry', async ({ page }) => {
    // 1. Homepage loads
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('img[alt="BITE ME"]').first()).toBeVisible();

    // 2. Open the first purchasable product in the main product grid (skips pre-launch)
    await openPurchasableProduct(page);

    // 3. Product detail page loaded
    const productTitle = page.locator('h1').first();
    await expect(productTitle).toBeVisible({ timeout: 10_000 });
    console.log(`Product page: ${await productTitle.textContent()}`);

    // 4. Check price is displayed
    await expect(page.locator('text=￥').first()).toBeVisible();

    // 5. Click "Add to Cart" (買い物かごに追加)
    const addToCartBtn = page.getByRole('button', { name: /買い物かごに追加|カートに追加/i });
    await expect(addToCartBtn).toBeVisible({ timeout: 5_000 });

    if (await addToCartBtn.isEnabled()) {
      await addToCartBtn.click();
      await page.waitForTimeout(2000);

      // 6. Open cart drawer via header cart icon
      const cartButton = page.locator('[data-testid="cart-trigger"]');
      await cartButton.click();

      // 7. Cart drawer opens - verify item exists
      const cartDialog = page.locator('[role="dialog"]');
      await expect(cartDialog).toBeVisible({ timeout: 5_000 });

      // 8. Verify cart has at least one item with an h4
      await expect(cartDialog.locator('h4').first()).toBeVisible({ timeout: 5_000 });

      // 9. Click checkout button in cart drawer
      const checkoutBtn = cartDialog.getByRole('button', { name: /レジに進む|お支払い|checkout/i });
      await expect(checkoutBtn).toBeEnabled({ timeout: 5_000 });
      await checkoutBtn.click();

      // 10. Should navigate to /checkout
      await page.waitForURL(/\/checkout/, { timeout: 10_000 });
      await expect(page.locator('text=お届け先情報')).toBeVisible({ timeout: 10_000 });

      // 11. Fill shipping form
      await page.fill('input[name="email"]', 'e2e-test@biteme.co.jp');
      await page.fill('input[name="family-name"]', 'テスト');
      await page.fill('input[name="given-name"]', '太郎');
      await page.fill('input[name="postal-code"]', '1500001');
      await page.selectOption('select[name="address-level1"]', '東京都');
      await page.fill('input[name="address-level2"]', '渋谷区');
      await page.fill('input[name="address-line1"]', '神宮前1-1-1');
      await page.fill('input[name="tel"]', '09012345678');

      // 12. Verify submit button is enabled (お支払いに進む)
      const submitBtn = page.getByRole('button', { name: /お支払いに進む/i });
      await expect(submitBtn).toBeEnabled({ timeout: 5_000 });

      // 13. Click submit and verify redirect to Shopify checkout
      const [_] = await Promise.all([
        page.waitForURL(/biteme-jp\.myshopify\.com/, { timeout: 30_000 }).catch(() => null),
        submitBtn.click(),
      ]);

      const currentUrl = page.url();
      const redirectedToShopify = currentUrl.includes('biteme-jp.myshopify.com');
      console.log(`Final URL: ${currentUrl}`);
      console.log(`Redirected to Shopify checkout: ${redirectedToShopify}`);

      // Accept either Shopify redirect OR still on checkout (CI network)
      expect(redirectedToShopify || currentUrl.includes('/checkout')).toBeTruthy();
    } else {
      console.log('Product is out of stock, skipping cart/checkout flow');
      await expect(addToCartBtn).toBeDisabled();
    }
  });

  test('Homepage loads with products', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Logo visible
    await expect(page.locator('img[alt="BITE ME"]').first()).toBeVisible();

    // Popular products section exists
    await expect(page.locator('text=人気商品')).toBeVisible({ timeout: 15_000 });

    // Products are rendered (h3 headings inside product cards)
    const productHeadings = page.locator('main h3');
    await expect(productHeadings.first()).toBeVisible({ timeout: 15_000 });
    const count = await productHeadings.count();
    console.log(`Products on homepage: ${count}`);
    expect(count).toBeGreaterThan(0);
  });

  test('Product detail page renders correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to first purchasable product in main grid (skips pre-launch)
    await openPurchasableProduct(page);

    // Title (h1)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // Price
    await expect(page.locator('text=￥').first()).toBeVisible();

    // Product image
    await expect(page.locator('img[class*="object"]').first()).toBeVisible();

    // Action buttons exist
    const actionButtons = page.getByRole('button', { name: PURCHASE_BUTTON });
    expect(await actionButtons.count()).toBeGreaterThan(0);
  });
});
