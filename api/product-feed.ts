import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || '';
const CLIENT_ID = process.env.VITE_SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = '2025-07';
const STORE_URL = 'https://biteme.co.jp';

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

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        description
        productType
        images(first: 1) { nodes { url } }
        variants(first: 1) {
          nodes {
            price { amount currencyCode }
            availableForSale
          }
        }
      }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  description: string;
  productType: string;
  images: { nodes: { url: string }[] };
  variants: { nodes: { price: { amount: string; currencyCode: string }; availableForSale: boolean }[] };
}

async function fetchAllProducts(): Promise<ProductNode[]> {
  const token = await getStorefrontToken();
  const products: ProductNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const res = await fetch(`https://${SHOP}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Shopify-Storefront-Private-Token': token,
      },
      body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
    });

    if (!res.ok) throw new Error(`Shopify Storefront error: ${res.status}`);
    const data = await res.json();
    const page = data?.data?.products;
    if (!page) break;

    products.push(...page.nodes);
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return products;
}

function escapeXml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildFeed(products: ProductNode[]): string {
  const items = products
    .map((product) => {
      const variant = product.variants.nodes[0];
      if (!variant) return '';

      const numericId = product.id.split('/').pop()!;
      const link = `${STORE_URL}/product/${numericId}`;
      const image = product.images.nodes[0]?.url || '';
      const price = `${Math.round(parseFloat(variant.price.amount))} JPY`;
      const availability = variant.availableForSale ? 'in stock' : 'out of stock';
      const title = escapeXml(product.title);
      const description = escapeXml((product.description || product.title).slice(0, 5000));

      return `
    <item>
      <g:id>${numericId}</g:id>
      <title>${title}</title>
      <description>${description}</description>
      <link>${link}</link>
      ${image ? `<g:image_link>${escapeXml(image)}</g:image_link>` : ''}
      <g:condition>new</g:condition>
      <g:availability>${availability}</g:availability>
      <g:price>${price}</g:price>
      <g:brand>BITE ME</g:brand>
    </item>`;
    })
    .filter(Boolean)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>BITE ME JAPAN</title>
    <link>${STORE_URL}</link>
    <description>BITE ME JAPAN ペット用品オンラインショップ</description>
    ${items}
  </channel>
</rss>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const products = await fetchAllProducts();
    const xml = buildFeed(products);

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(xml);
  } catch (error) {
    console.error('[Product Feed]', error);
    return res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><error>Feed generation failed</error>');
  }
}
