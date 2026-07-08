import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * 자동 할인(Automatic Discount) 조회 엔드포인트 — Admin API 기반.
 *
 * 기존에는 프론트가 상품마다 Storefront `cartCreate`(할인 미리보기)를 호출해
 * 자동 할인율을 감지했으나, 카트 뮤테이션은 Vercel 서버 IP 기준으로 rate limit이
 * 걸려 상시 THROTTLED → 리스트·상세에서 할인이 표시되지 않는 문제가 있었다.
 *
 * 이 엔드포인트는 Admin `automaticDiscountNodes`를 읽어 {상품ID → 할인율%} 맵을
 * 반환한다. Admin API는 카트 IP 버킷과 완전히 별개라 안정적이며, 결과는 캐시된다.
 *
 * ⚠️ 필요 스코프: REPORT 앱에 `read_discounts`.
 *    스코프가 없거나 조회 실패 시 빈 맵(200)을 반환 → 프론트는 정가로 graceful degrade.
 */

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) return cachedToken;

  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing REPORT_SHOPIFY_CLIENT_ID or REPORT_SHOPIFY_CLIENT_SECRET');
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken!;
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Admin API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// customerGets.items 형태별 필드
interface DiscountNode {
  automaticDiscount: {
    __typename: string;
    title?: string;
    status?: string;
    startsAt?: string;
    endsAt?: string | null;
    minimumRequirement?: { __typename: string } | null;
    customerGets?: {
      value: {
        __typename: string;
        percentage?: number; // 0.0 ~ 1.0
      };
      items: {
        __typename: string;
        allItems?: boolean;
        products?: { edges: { node: { id: string } }[] };
        collections?: { edges: { node: { id: string } }[] };
      };
    };
  };
}

const DISCOUNTS_QUERY = `
  query AutomaticDiscounts {
    automaticDiscountNodes(first: 50) {
      edges {
        node {
          automaticDiscount {
            __typename
            ... on DiscountAutomaticBasic {
              title
              status
              startsAt
              endsAt
              minimumRequirement { __typename }
              customerGets {
                value {
                  __typename
                  ... on DiscountPercentage { percentage }
                }
                items {
                  __typename
                  ... on AllDiscountItems { allItems }
                  ... on DiscountProducts { products(first: 250) { edges { node { id } } } }
                  ... on DiscountCollections { collections(first: 50) { edges { node { id } } } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const COLLECTION_PRODUCTS_QUERY = `
  query CollectionProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node { id } }
      }
    }
  }
`;

interface DiscountResult {
  productMap: Record<string, number>; // productId(gid) → 할인율(%)
  allItemsPercentage: number;         // 전상품 대상 자동할인 중 최대 %
  updatedAt: string;
}

let cache: DiscountResult | null = null;
let cacheAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10분

async function collectionProductIds(token: string, collectionId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await adminGraphQL(token, COLLECTION_PRODUCTS_QUERY, { id: collectionId, cursor });
    const conn = data?.data?.collection?.products;
    if (!conn) break;
    for (const e of conn.edges) ids.push(e.node.id);
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor && ids.length < 2000);
  return ids;
}

async function buildDiscountMap(): Promise<DiscountResult> {
  const token = await getAccessToken();
  const data: any = await adminGraphQL(token, DISCOUNTS_QUERY);
  const nodes: DiscountNode[] = (data?.data?.automaticDiscountNodes?.edges || []).map((e: any) => e.node);

  const productMap: Record<string, number> = {};
  let allItemsPercentage = 0;
  const now = Date.now();

  for (const node of nodes) {
    const d = node.automaticDiscount;
    if (d.__typename !== 'DiscountAutomaticBasic') continue;       // v1: 기본 할인만 (BxGy/App 제외)
    if (d.status && d.status !== 'ACTIVE') continue;               // 활성만
    if (d.startsAt && new Date(d.startsAt).getTime() > now) continue;
    if (d.endsAt && new Date(d.endsAt).getTime() < now) continue;
    if (d.minimumRequirement) continue;                           // v1: 최소구매조건 있으면 배지 미표시(보수적)

    const value = d.customerGets?.value;
    if (value?.__typename !== 'DiscountPercentage' || !value.percentage) continue;
    const pct = Math.round(value.percentage * 100);
    if (pct <= 0) continue;

    const items = d.customerGets!.items;
    if (items.__typename === 'AllDiscountItems' && items.allItems) {
      allItemsPercentage = Math.max(allItemsPercentage, pct);
    } else if (items.__typename === 'DiscountProducts' && items.products) {
      for (const e of items.products.edges) {
        productMap[e.node.id] = Math.max(productMap[e.node.id] || 0, pct);
      }
    } else if (items.__typename === 'DiscountCollections' && items.collections) {
      for (const c of items.collections.edges) {
        const ids = await collectionProductIds(token, c.node.id);
        for (const id of ids) productMap[id] = Math.max(productMap[id] || 0, pct);
      }
    }
  }

  return { productMap, allItemsPercentage, updatedAt: new Date().toISOString() };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const now = Date.now();
    if (!cache || now - cacheAt > CACHE_TTL) {
      cache = await buildDiscountMap();
      cacheAt = now;
    }
    // 엣지/브라우저 캐시 (할인은 자주 안 바뀜)
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json(cache);
  } catch (err) {
    // 스코프 부재/조회 실패 시에도 프론트가 정가로 degrade 하도록 빈 맵 반환
    console.error('[automatic-discounts] failed:', err instanceof Error ? err.message : err);
    return res.status(200).json({ productMap: {}, allItemsPercentage: 0, updatedAt: new Date().toISOString(), error: true });
  }
}
