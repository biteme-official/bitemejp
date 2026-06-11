import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
const STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';
const STORE_URL = 'https://biteme.co.jp';

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
  const products: ProductNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const res = await fetch(`https://${SHOP}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Shopify-Storefront-Private-Token': STOREFRONT_TOKEN,
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
