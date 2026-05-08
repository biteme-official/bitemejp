import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || '';
const CLIENT_ID = process.env.VITE_SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = '2025-07';
const BASE_URL = 'https://biteme.co.jp';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getStorefrontToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) return cachedToken;

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) throw new Error(`Token error: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken!;
}

async function fetchAllProductHandles(): Promise<{ handle: string; updatedAt: string }[]> {
  const token = await getStorefrontToken();
  const products: { handle: string; updatedAt: string }[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { handle updatedAt } }
        }
      }
    `;

    const res = await fetch(`https://${SHOP}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Shopify-Storefront-Private-Token': token,
      },
      body: JSON.stringify({ query, variables: { cursor } }),
    });

    if (!res.ok) break;
    const data = await res.json();
    const connection = data?.data?.products;
    if (!connection) break;

    for (const edge of connection.edges) {
      products.push({ handle: edge.node.handle, updatedAt: edge.node.updatedAt });
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return products;
}

const STATIC_PAGES = [
  { loc: '/',        priority: '1.0', changefreq: 'weekly'  },
  { loc: '/contact', priority: '0.5', changefreq: 'monthly' },
  { loc: '/tokusho', priority: '0.4', changefreq: 'monthly' },
  { loc: '/privacy', priority: '0.3', changefreq: 'monthly' },
  { loc: '/terms',   priority: '0.3', changefreq: 'monthly' },
];

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const products = await fetchAllProductHandles();

    const staticUrls = STATIC_PAGES.map(p =>
      `  <url>\n    <loc>${BASE_URL}${p.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    );

    const productUrls = products.map(p =>
      `  <url>\n    <loc>${BASE_URL}/product/${p.handle}</loc>\n    <lastmod>${p.updatedAt.split('T')[0]}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`
    );

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...staticUrls,
      ...productUrls,
      '</urlset>',
    ].join('\n');

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).send(xml);
  } catch (error) {
    console.error('[Sitemap]', error);
    return res.status(500).send('<?xml version="1.0"?><error>Failed to generate sitemap</error>');
  }
}
