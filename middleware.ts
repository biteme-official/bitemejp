import { next } from '@vercel/edge';
import { SHOPIFY_API_VERSION } from './api/_shopify-api-version.js';

/**
 * 검색·쇼핑 크롤러에게 「누가, 무엇을, 얼마에」 파는지가 HTML 원문에 들어간 페이지를 준다.
 *
 * 이 사이트는 SPA 라 원문 HTML 은 공통 껍데기뿐이고 상품명·가격·사업자 정보는 스크립트가 돌아야 나온다.
 * 구글 판매자 센터는 2026-06 「허위 진술(Misrepresentation)」로 반려했는데, 그 사유가
 * 「비즈니스 정보·정책 투명 공개」「상품 데이터와 상점 일치」였다 — 크롤러에게는 둘 다 비어 보였다.
 *
 * 🔴 2026-10-01 까지 이 프리렌더는 **조용히 고장 나 있었다**(6/4 롤백 이후).
 *    Storefront 를 client_credentials 토큰 + `Authorization: Bearer` 로 불러 항상 실패 → `next()` 로 빠져
 *    봇도 빈 껍데기를 받았다. 9/18 #184 에서 api/ 7곳은 Private 토큰으로 고쳤는데 이 파일만 빠졌었다.
 *    그리고 `googlebot` 만 봐서 판매자 센터 크롤러(Storebot-Google)·광고 크롤러(AdsBot-Google)는 애초에 대상이 아니었다.
 *
 * 하는 일 (봇에게만. 사람에게는 아무것도 바꾸지 않는다):
 *   - `/product/:id`  상품명·가격(자동 할인 반영, 화면과 같은 값)·재고·옵션·설명 + Product 구조화 데이터
 *                      상품이 없으면 404
 *   - `/tokusho`      특정상거래법 표기 본문 (Shopify 「Legal notice」 그대로)
 *   - 앱에 없는 주소  404 (예전에는 무엇이든 200 이라 지운 상품 링크도 「정상 페이지」로 보였다)
 *   - 그 밖의 아는 주소 → 그대로 통과
 * 모든 프리렌더 페이지 하단에 판매자 연락처와 정책 링크를 둔다.
 *
 * 조회가 실패하면(네트워크·토큰) 404 를 내지 않고 그냥 통과시킨다 — 일시 장애가 상품 삭제로 보이면 안 된다.
 */

export const config = {
  // api·정적 파일(확장자 있는 경로)은 건드리지 않는다
  matcher: ['/((?!api/|assets/|.*\\..*).*)'],
};

export const BOT_UA =
  /googlebot|storebot-google|adsbot-google|google-inspectiontool|googleother|mediapartners-google|bingbot|yandex|baiduspider|duckduckbot|slurp|facebookexternalhit|facebookbot|twitterbot|linkedinbot|applebot|rogerbot|embedly|outbrain|pinterest|whatsapp|telegrambot|discordbot|slackbot/i;

const SITE = 'https://biteme.co.jp';
const SITE_NAME = 'バイトミー (BITEME) JAPAN';
const SELLER_NAME = 'バイトミー JAPAN';
/** index.html 의 Organization 구조화 데이터·특정상거래법 표기와 같은 값으로 둘 것 */
const CONTACT_EMAIL = 'japan@biteme.co.kr';
const CONTACT_TEL = '03-6868-3009';
const SUPPORT_HOURS = '平日 10:00 - 18:00';
const BRAND = 'BITE ME';

/**
 * src/App.tsx 의 <Route path> 와 같이 움직여야 한다.
 * 🔴 여기 없는 주소는 봇에게 404 가 나간다 — 라우트를 추가하면 이 목록에도 넣을 것.
 */
const KNOWN_ROUTES: RegExp[] = [
  /^\/$/,
  /^\/product\/[^/]+$/,
  /^\/checkout$/,
  /^\/r\/[^/]+$/,
  /^\/cart\/restore$/,
  /^\/checkout-return$/,
  /^\/contact$/,
  /^\/privacy$/,
  /^\/terms$/,
  /^\/auth\/line\/callback$/,
  /^\/line-login$/,
  /^\/mypage$/,
  /^\/wishlist$/,
  /^\/admin$/,
  /^\/tokusho$/,
  /^\/about$/,
  /^\/discount\/[^/]+$/,
  /^\/a\/[^/]+$/,
  /^\/blog$/,
  /^\/blog\/[^/]+$/,
  /^\/affiliate$/,
  /^\/affiliate\/terms$/,
  /^\/partner$/,
  /^\/partner\/join$/,
];

export function isKnownRoute(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return KNOWN_ROUTES.some((r) => r.test(p));
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 화면(ProductDetail)과 같은 표기 — 엔화는 소수점 없이 */
export function yen(amount: number): string {
  return `¥${Math.round(amount).toLocaleString('ja-JP')}`;
}

/**
 * 자동 할인 반영 가격. ProductDetail 과 같은 계산(할인액을 먼저 반올림)이라야 화면·피드와 1엔도 안 어긋난다.
 * api/product-feed.ts 의 sale_price 도 같은 식을 쓴다.
 */
export function discountedPrice(price: number, pct: number): number {
  if (!pct) return Math.round(price);
  return Math.round(price - Math.round((price * pct) / 100));
}

// ─── Shopify ────────────────────────────────────────────────────────────────

interface Money { amount: string; currencyCode: string }
export interface BotProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  vendor: string;
  images: { url: string; altText: string | null }[];
  variants: { title: string; availableForSale: boolean; price: Money; compareAtPrice: Money | null }[];
}

const PRODUCT_QUERY = `query BotProduct($id: ID, $handle: String) {
  product(id: $id, handle: $handle) {
    id title handle description vendor
    images(first: 5) { nodes { url altText } }
    variants(first: 50) { nodes { title availableForSale price { amount currencyCode } compareAtPrice { amount currencyCode } } }
  }
}`;

/** null = 상품 없음, undefined = 조회 실패(판단 보류) */
async function fetchProduct(idOrHandle: string): Promise<BotProduct | null | undefined> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN;
  if (!shop || !token) return undefined;
  const variables = /^\d+$/.test(idOrHandle)
    ? { id: `gid://shopify/Product/${idOrHandle}` }
    : { handle: decodeURIComponent(idOrHandle) };
  try {
    const res = await fetch(`https://${shop}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Shopify-Storefront-Private-Token': token },
      body: JSON.stringify({ query: PRODUCT_QUERY, variables }),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: { product: (Omit<BotProduct, 'images' | 'variants'> & {
        images: { nodes: BotProduct['images'] };
        variants: { nodes: BotProduct['variants'] };
      }) | null };
      errors?: unknown;
    };
    if (!json.data || json.errors) return undefined;
    const p = json.data.product;
    if (!p) return null;
    return { ...p, images: p.images.nodes, variants: p.variants.nodes };
  } catch {
    return undefined;
  }
}

/** 자동 할인율(%). 화면과 같은 /api/automatic-discounts 를 읽는다. 실패하면 0 (정가) */
async function fetchDiscountPct(origin: string, productGid: string): Promise<number> {
  try {
    const res = await fetch(`${origin}/api/automatic-discounts`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return 0;
    const d = (await res.json()) as { productMap?: Record<string, number>; allItemsPercentage?: number };
    return Math.max(d.productMap?.[productGid] ?? 0, d.allItemsPercentage ?? 0);
  } catch {
    return 0;
  }
}

/** 특정상거래법 표기 본문 HTML. 실패하면 null */
async function fetchLegalNotice(origin: string): Promise<string | null> {
  try {
    const res = await fetch(`${origin}/api/policies`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const d = (await res.json()) as { policy?: { body?: string } | null };
    const body = d.policy?.body;
    if (!body) return null;
    // 우리 Shopify 에서 온 본문이지만 스크립트·이벤트 속성은 걷어낸다
    return body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '');
  } catch {
    return null;
  }
}

// ─── HTML ───────────────────────────────────────────────────────────────────

interface PageParts {
  title: string;
  description: string;
  canonical?: string;
  noindex?: boolean;
  ogImage?: string;
  ogType?: string;
  jsonLd?: unknown[];
  body: string;
}

export function layout(p: PageParts): string {
  const title = escapeHtml(p.title);
  const description = escapeHtml(p.description);
  const ld = (p.jsonLd ?? []).map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta name="robots" content="${p.noindex ? 'noindex' : 'index, follow'}" />
${p.canonical ? `<link rel="canonical" href="${escapeHtml(p.canonical)}" />` : ''}
<meta property="og:site_name" content="${SITE_NAME}" />
<meta property="og:type" content="${p.ogType ?? 'website'}" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
${p.ogImage ? `<meta property="og:image" content="${escapeHtml(p.ogImage)}" />` : ''}
${p.canonical ? `<meta property="og:url" content="${escapeHtml(p.canonical)}" />` : ''}
<meta property="og:locale" content="ja_JP" />
${ld}
</head>
<body>
<header><a href="${SITE}/">${SITE_NAME}</a></header>
<main>
${p.body}
</main>
<footer>
<p>${SITE_NAME}</p>
<p>お問い合わせ：<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> ／ 電話：${CONTACT_TEL}（${SUPPORT_HOURS}）</p>
<nav>
<a href="${SITE}/tokusho">特定商取引法に基づく表記</a> ・
<a href="${SITE}/privacy">プライバシーポリシー</a> ・
<a href="${SITE}/terms">利用規約</a> ・
<a href="${SITE}/contact">お問い合わせ</a> ・
<a href="${SITE}/about">ブランドについて</a>
</nav>
</footer>
</body>
</html>`;
}

export function productPage(p: BotProduct, pct: number): string {
  const numericId = p.id.split('/').pop()!;
  const canonical = `${SITE}/product/${numericId}`;
  const first = p.variants[0];
  const currency = first?.price.currencyCode ?? 'JPY';
  const base = first ? parseFloat(first.price.amount) : 0;
  const sale = discountedPrice(base, pct);
  const compareAt = first?.compareAtPrice ? parseFloat(first.compareAtPrice.amount) : 0;
  const available = p.variants.some((v) => v.availableForSale);
  // 피드(api/product-feed.ts)의 g:brand 와 같은 값. Shopify vendor 는 「BITEME.JP」 같은 스토어 이름이라 쓰지 않는다
  const brand = BRAND;

  let priceHtml: string;
  if (pct > 0) {
    priceHtml = `<p>販売価格 <strong>${yen(sale)}</strong>（税込） <s>${yen(base)}</s> ${pct}%OFF</p>`;
  } else if (compareAt > base) {
    priceHtml = `<p>販売価格 <strong>${yen(base)}</strong>（税込） <s>${yen(compareAt)}</s></p>`;
  } else {
    priceHtml = `<p>販売価格 <strong>${yen(base)}</strong>（税込）</p>`;
  }

  const variantRows =
    p.variants.length > 1
      ? `<h2>オプション</h2>
<table>
<thead><tr><th>オプション</th><th>価格（税込）</th><th>在庫</th></tr></thead>
<tbody>
${p.variants
  .map((v) => `<tr><td>${escapeHtml(v.title)}</td><td>${yen(discountedPrice(parseFloat(v.price.amount), pct))}</td><td>${v.availableForSale ? '在庫あり' : '在庫なし'}</td></tr>`)
  .join('\n')}
</tbody>
</table>`
      : '';

  const description = p.description
    ? p.description
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => `<p>${escapeHtml(l)}</p>`)
        .join('\n')
    : '';

  const images = p.images
    .map((img) => `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.altText || p.title)}" />`)
    .join('\n');

  const offers = p.variants.map((v) => ({
    '@type': 'Offer',
    url: canonical,
    priceCurrency: v.price.currencyCode,
    price: String(discountedPrice(parseFloat(v.price.amount), pct)),
    availability: v.availableForSale ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    itemCondition: 'https://schema.org/NewCondition',
    seller: { '@type': 'Organization', name: SELLER_NAME },
  }));

  return layout({
    title: `${p.title} | ${SITE_NAME}`,
    description: (p.description || `${SELLER_NAME} 公式 ${p.title}`).slice(0, 160),
    canonical,
    ogType: 'product',
    ogImage: p.images[0]?.url,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: p.title,
        image: p.images.map((i) => i.url),
        description: p.description,
        brand: { '@type': 'Brand', name: brand },
        offers: offers.length === 1 ? offers[0] : offers,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: p.title, item: canonical },
        ],
      },
    ],
    body: `<nav><a href="${SITE}/">ホーム</a> &gt; ${escapeHtml(p.title)}</nav>
<h1>${escapeHtml(p.title)}</h1>
<p>ブランド：${escapeHtml(brand)}</p>
${images}
${priceHtml}
<p>${available ? '在庫あり' : '在庫なし'}</p>
${variantRows}
<h2>商品説明</h2>
${description}
<h2>送料・お届け・返品について</h2>
<p>送料、お届けまでの日数、返品・交換の条件、お支払い方法は<a href="${SITE}/tokusho">特定商取引法に基づく表記</a>をご覧ください。</p>
<p>販売：${SELLER_NAME}</p>`,
  });
}

export function legalNoticePage(bodyHtml: string): string {
  return layout({
    title: `特定商取引法に基づく表記 | ${SITE_NAME}`,
    description: `${SITE_NAME}の特定商取引法に基づく表記（販売業者・所在地・連絡先・送料・返品について）`,
    canonical: `${SITE}/tokusho`,
    body: `<h1>特定商取引法に基づく表記</h1>\n${bodyHtml}`,
  });
}

export function notFoundPage(): string {
  return layout({
    title: `ページが見つかりません | ${SITE_NAME}`,
    description: 'お探しのページは見つかりませんでした。',
    noindex: true,
    body: `<h1>ページが見つかりません</h1>
<p>お探しのページは削除されたか、URLが変更された可能性があります。</p>
<p><a href="${SITE}/">トップページへ戻る</a></p>`,
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, s-maxage=600, stale-while-revalidate=3600' : 'public, s-maxage=300',
      'X-Prerendered': 'bot',
    },
  });
}

const PRODUCT_PATH = /^\/product\/([^/]+)\/?$/;

export default async function middleware(request: Request): Promise<Response> {
  const ua = request.headers.get('user-agent') || '';
  if (!BOT_UA.test(ua)) return next();

  const url = new URL(request.url);
  const path = url.pathname;

  const productMatch = path.match(PRODUCT_PATH);
  if (productMatch) {
    const product = await fetchProduct(productMatch[1]);
    if (product === undefined) return next(); // 조회 실패 — 판단하지 않는다
    if (product === null) return html(notFoundPage(), 404);
    const pct = await fetchDiscountPct(url.origin, product.id);
    return html(productPage(product, pct));
  }

  if (path === '/tokusho' || path === '/tokusho/') {
    const body = await fetchLegalNotice(url.origin);
    return body ? html(legalNoticePage(body)) : next();
  }

  if (!isKnownRoute(path)) return html(notFoundPage(), 404);
  return next();
}
