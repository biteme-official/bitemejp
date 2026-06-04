import { next } from '@vercel/edge';

// Search engine + social crawler bots that need pre-rendered meta tags
const BOT_UA =
  /googlebot|bingbot|yandex|baiduspider|duckduckbot|slurp|facebookexternalhit|facebookbot|twitterbot|linkedinbot|applebot|rogerbot|embedly|outbrain|pinterest|whatsapp|telegrambot|discordbot|slackbot/i;

const PRODUCT_PATH = /^\/product\/(\d+)$/;

export const config = {
  matcher: ['/product/:path*'],
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function getStorefrontToken(): Promise<string> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN!;
  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID!;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET!;

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

interface ProductMeta {
  title: string;
  description: string;
  image: string;
  price: string;
  currencyCode: string;
  isAvailable: boolean;
  vendor: string;
}

async function fetchProductMeta(numericId: string): Promise<ProductMeta | null> {
  try {
    const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN!;
    const token = await getStorefrontToken();

    const res = await fetch(`https://${shop}/api/2025-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `query GetProductMeta($id: ID!) {
          product(id: $id) {
            title
            description
            vendor
            images(first: 1) { edges { node { url } } }
            variants(first: 1) {
              edges {
                node {
                  price { amount currencyCode }
                  availableForSale
                }
              }
            }
          }
        }`,
        variables: { id: `gid://shopify/Product/${numericId}` },
      }),
    });

    const data = (await res.json()) as { data: { product: { title: string; description: string; vendor: string; images: { edges: { node: { url: string } }[] }; variants: { edges: { node: { price: { amount: string; currencyCode: string }; availableForSale: boolean } }[] } } } };
    const p = data?.data?.product;
    if (!p) return null;

    const variant = p.variants.edges[0]?.node;
    return {
      title: p.title,
      description: p.description?.slice(0, 160) || '',
      image: p.images.edges[0]?.node.url || 'https://biteme.co.jp/meta.jpg',
      price: variant?.price.amount || '',
      currencyCode: variant?.price.currencyCode || 'JPY',
      isAvailable: variant?.availableForSale ?? false,
      vendor: p.vendor || 'BITEME',
    };
  } catch {
    return null;
  }
}

function buildBotHtml(meta: ProductMeta, numericId: string): string {
  const canonical = `https://biteme.co.jp/product/${numericId}`;
  const pageTitle = escapeHtml(`${meta.title} | バイトミー (BITEME) JAPAN`);
  const description = escapeHtml(meta.description || `バイトミー公式 ${meta.title}`);
  const image = escapeHtml(meta.image);

  const productJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: meta.title,
    image: [meta.image],
    description: meta.description,
    brand: { '@type': 'Brand', name: meta.vendor },
    offers: {
      '@type': 'Offer',
      url: canonical,
      priceCurrency: meta.currencyCode,
      price: meta.price,
      availability: meta.isAvailable
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: 'バイトミー JAPAN' },
    },
  });

  const breadcrumbJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ホーム', item: 'https://biteme.co.jp/' },
      { '@type': 'ListItem', position: 2, name: meta.title, item: canonical },
    ],
  });

  const priceDisplay =
    meta.price && meta.currencyCode === 'JPY'
      ? `¥${Math.round(parseFloat(meta.price)).toLocaleString('ja-JP')}`
      : meta.price;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${pageTitle}</title>
<meta name="description" content="${description}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${canonical}" />
<meta property="og:type" content="product" />
<meta property="og:site_name" content="バイトミー (BITEME) JAPAN" />
<meta property="og:title" content="${pageTitle}" />
<meta property="og:description" content="${description}" />
<meta property="og:image" content="${image}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:locale" content="ja_JP" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${pageTitle}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="${image}" />
<script type="application/ld+json">${productJsonLd}</script>
<script type="application/ld+json">${breadcrumbJsonLd}</script>
</head>
<body>
<nav><a href="https://biteme.co.jp/">バイトミー (BITEME) JAPAN</a></nav>
<main>
<h1>${escapeHtml(meta.title)}</h1>
${meta.description ? `<p>${escapeHtml(meta.description)}</p>` : ''}
${priceDisplay ? `<p>${priceDisplay}</p>` : ''}
<p>${meta.isAvailable ? '在庫あり' : '在庫なし'}</p>
</main>
</body>
</html>`;
}

export default async function middleware(request: Request): Promise<Response> {
  const ua = request.headers.get('user-agent') || '';
  const url = new URL(request.url);
  const productMatch = url.pathname.match(PRODUCT_PATH);

  if (!productMatch || !BOT_UA.test(ua)) {
    return next();
  }

  const numericId = productMatch[1];
  const meta = await fetchProductMeta(numericId);

  if (!meta) {
    return next();
  }

  return new Response(buildBotHtml(meta, numericId), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
      'X-Prerendered': 'bot',
    },
  });
}
