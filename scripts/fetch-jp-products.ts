/**
 * Shopify(co.jp) 전체 상품 목록 수집
 *
 * 사용법: npx tsx scripts/fetch-jp-products.ts
 * 결과:  data/jp-products.json
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const STORE_DOMAIN = process.env.VITE_SHOPIFY_STORE_DOMAIN!;
const CLIENT_ID = process.env.VITE_SHOPIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!;
const API_VERSION = '2025-07';

export interface JpProduct {
  id: string;         // gid://shopify/Product/XXXX
  numericId: string;  // XXXX (숫자만)
  title: string;      // 일본어 상품명
  handle: string;
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Token error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function fetchAllProducts(token: string): Promise<JpProduct[]> {
  const query = `
    query GetProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node { id title handle }
        }
      }
    }
  `;

  const products: JpProduct[] = [];
  let after: string | null = null;

  while (true) {
    const res = await fetch(`https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Shopify-Storefront-Private-Token': token,
      },
      body: JSON.stringify({ query, variables: { first: 250, after } }),
    });

    if (!res.ok) throw new Error(`GraphQL error: ${res.status}`);
    const data = await res.json();
    const productsData = data.data?.products;

    for (const edge of productsData.edges) {
      const { id, title, handle } = edge.node;
      const numericId = id.split('/').pop()!;
      products.push({ id, numericId, title, handle });
    }

    console.log(`  수집: ${products.length}개`);

    if (!productsData.pageInfo.hasNextPage) break;
    after = productsData.pageInfo.endCursor;
  }

  return products;
}

const dataDir = join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

console.log('co.jp 상품 수집 시작...');
const token = await getAccessToken();
const products = await fetchAllProducts(token);

writeFileSync(join(dataDir, 'jp-products.json'), JSON.stringify(products, null, 2), 'utf-8');
console.log(`✓ 완료: ${products.length}개 → data/jp-products.json`);
