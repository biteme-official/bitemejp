import { toast } from "sonner";
import { getGA4ClientId, getGA4SessionId } from './ga4-ecommerce';

// Shopify API - requests go through the server proxy which handles authentication
const SHOPIFY_PROXY_URL = import.meta.env.VITE_SHOPIFY_PROXY_URL || '/api/shopify';

export interface ShopifyProduct {
  node: {
    id: string;
    title: string;
    description: string;
    descriptionHtml: string;
    handle: string;
    productType: string;
    tags: string[];
    vendor: string;
    priceRange: {
      minVariantPrice: {
        amount: string;
        currencyCode: string;
      };
    };
    images: {
      edges: Array<{
        node: {
          url: string;
          altText: string | null;
        };
      }>;
    };
    variants: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          price: {
            amount: string;
            currencyCode: string;
          };
          compareAtPrice: {
            amount: string;
            currencyCode: string;
          } | null;
          availableForSale: boolean;
          quantityAvailable: number | null;
          image?: {
            url: string;
            altText: string | null;
          } | null;
          selectedOptions: Array<{
            name: string;
            value: string;
          }>;
        };
      }>;
    };
    options: Array<{
      name: string;
      values: string[];
    }>;
  };
}

// 예약배송 태그 파싱: "preorder:YYYY-MM-DD" 형식 태그에서 날짜 추출
export function getPreorderDate(tags: string[]): string | null {
  const tag = tags.find(t => t.startsWith('preorder:'));
  if (!tag) return null;
  const date = tag.split(':')[1];
  return date || null;
}

// Storefront API helper function - proxied through server for secure token management
export async function storefrontApiRequest(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(SHOPIFY_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (response.status === 402) {
    toast.error("Shopify: Payment required", {
      description: "Shopify API access requires an active Shopify billing plan. Visit https://admin.shopify.com to upgrade.",
    });
    return null;
  }

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();

  if (data.errors) {
    throw new Error(`Error calling Shopify: ${data.errors.map((e: { message: string }) => e.message).join(', ')}`);
  }

  return data;
}

// GraphQL Queries
const GET_PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $query: String, $after: String) {
    products(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          description
          handle
          productType
          tags
          vendor
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          images(first: 5) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price {
                  amount
                  currencyCode
                }
                compareAtPrice {
                  amount
                  currencyCode
                }
                availableForSale
                image {
                  url
                  altText
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          options {
            name
            values
          }
        }
      }
    }
  }
`;

const GET_PRODUCTS_COUNT_QUERY = `
  query GetProductsCount($query: String) {
    products(first: 250, query: $query) {
      edges {
        node {
          id
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const GET_PRODUCT_BY_HANDLE_QUERY = `
  query GetProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      description
      descriptionHtml
      handle
      productType
      tags
      vendor
      priceRange {
        minVariantPrice {
          amount
          currencyCode
        }
      }
      images(first: 20) {
        edges {
          node {
            url
            altText
          }
        }
      }
      variants(first: 50) {
        edges {
          node {
            id
            title
            price {
              amount
              currencyCode
            }
            compareAtPrice {
              amount
              currencyCode
            }
            availableForSale
            quantityAvailable
            image {
              url
              altText
            }
            selectedOptions {
              name
              value
            }
          }
        }
      }
      options {
        name
        values
      }
    }
  }
`;

const CART_CREATE_MUTATION = `
  mutation cartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart {
        id
        checkoutUrl
        totalQuantity
        cost {
          totalAmount {
            amount
            currencyCode
          }
        }
        cost {
          subtotalAmount {
            amount
            currencyCode
          }
          totalAmount {
            amount
            currencyCode
          }
        }
        lines(first: 100) {
          edges {
            node {
              id
              quantity
              discountAllocations {
                discountedAmount {
                  amount
                  currencyCode
                }
              }
              cost {
                totalAmount {
                  amount
                  currencyCode
                }
              }
              merchandise {
                ... on ProductVariant {
                  id
                  title
                  price {
                    amount
                    currencyCode
                  }
                  compareAtPrice {
                    amount
                    currencyCode
                  }
                  product {
                    title
                    handle
                  }
                }
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface CartDiscountInfo {
  totalSavings: number;
  discountedTotal: number;
  currencyCode: string;
  lineDiscounts: Record<string, number>; // variantId → discount amount
  productDiscounts: Record<string, number>; // productId → discount percentage (0~100)
}

const CART_PREVIEW_MUTATION = `
  mutation cartPreview($input: CartInput!) {
    cartCreate(input: $input) {
      cart {
        cost {
          subtotalAmount { amount currencyCode }
          totalAmount { amount currencyCode }
        }
        lines(first: 100) {
          edges {
            node {
              quantity
              discountAllocations {
                ... on CartAutomaticDiscountAllocation {
                  discountedAmount { amount currencyCode }
                }
                ... on CartCodeDiscountAllocation {
                  discountedAmount { amount currencyCode }
                }
                ... on CartCustomDiscountAllocation {
                  discountedAmount { amount currencyCode }
                }
              }
              merchandise {
                ... on ProductVariant {
                  id
                  price { amount }
                  product { id }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// In-flight deduplication: same variant set → share one promise
const _cartPreviewInFlight = new Map<string, Promise<CartDiscountInfo | null>>();

function _cartPreviewKey(items: { variantId: string; quantity: number }[]): string {
  return [...items]
    .sort((a, b) => a.variantId.localeCompare(b.variantId))
    .map(i => `${i.variantId}:${i.quantity}`)
    .join('|');
}

async function _doFetchCartPreview(
  deduped: { variantId: string; quantity: number }[]
): Promise<CartDiscountInfo | null> {
  const attempt = async (): Promise<CartDiscountInfo | null> => {
    try {
      const data = await storefrontApiRequest(CART_PREVIEW_MUTATION, {
        input: {
          // 실제 체크아웃 카트(CART_CREATE_MUTATION)와 동일한 일본 마켓 컨텍스트로
          // 평가해야 마켓(국가)별로 스코프된 자동 할인이 미리보기에도 그대로 잡힌다.
          buyerIdentity: { countryCode: 'JP' },
          lines: deduped.map(item => ({
            merchandiseId: item.variantId,
            quantity: item.quantity,
          })),
        },
      });
      const cart = data?.data?.cartCreate?.cart;
      if (!cart) return null;

      const subtotal = parseFloat(cart.cost.subtotalAmount.amount);
      const total = parseFloat(cart.cost.totalAmount.amount);
      const currencyCode = cart.cost.totalAmount.currencyCode;
      const lineDiscounts: Record<string, number> = {};
      const productDiscounts: Record<string, number> = {};

      for (const edge of cart.lines.edges) {
        const node = edge.node;
        const variantId = node.merchandise?.id;
        const productId = node.merchandise?.product?.id;
        const variantPrice = parseFloat(node.merchandise?.price?.amount || '0');
        const discount = node.discountAllocations.reduce(
          (sum: number, d: { discountedAmount: { amount: string } }) => sum + parseFloat(d.discountedAmount.amount),
          0
        );
        // Always write (including 0) so stale positive values get overwritten when a discount ends
        if (variantId) lineDiscounts[variantId] = discount;
        if (productId && variantPrice > 0) {
          productDiscounts[productId] = discount > 0
            ? Math.round((discount / variantPrice) * 100)
            : 0;
        }
      }

      // lineDiscounts 합산으로 savings 계산, discountedTotal은 Shopify가 계산한 totalAmount 사용
      const savings = Object.values(lineDiscounts).reduce((sum, d) => sum + d, 0);
      return { totalSavings: savings, discountedTotal: total, currencyCode, lineDiscounts, productDiscounts };
    } catch (err) {
      console.error('[fetchCartPreview] failed:', err);
      return null;
    }
  };

  // 실패(null)·Shopify Throttled 시 지수 백오프로 재시도. 리스트에서 상품별 카트를
  // 다수 조회할 때 rate limit(Throttled)이 걸려도 점진적으로 복구되도록 한다.
  let result = await attempt();
  let delay = 800;
  for (let i = 0; i < 3 && result === null; i++) {
    await new Promise(r => setTimeout(r, delay));
    delay *= 2;
    result = await attempt();
  }
  return result;
}

export async function fetchCartPreview(
  items: { variantId: string; quantity: number }[]
): Promise<CartDiscountInfo | null> {
  if (items.length === 0) return null;
  // Deduplicate by variantId to prevent Shopify from merging lines and doubling discount amounts
  const seen = new Set<string>();
  const deduped = items.filter(item => {
    if (seen.has(item.variantId)) return false;
    seen.add(item.variantId);
    return true;
  });

  const key = _cartPreviewKey(deduped);
  if (_cartPreviewInFlight.has(key)) {
    return _cartPreviewInFlight.get(key)!;
  }
  const promise = _doFetchCartPreview(deduped);
  _cartPreviewInFlight.set(key, promise);
  promise.finally(() => _cartPreviewInFlight.delete(key));
  return promise;
}

// 자동 할인 맵 (Admin API 기반). Storefront `cartCreate`(카트 미리보기)는 모든 호출이
// Vercel 서버 IP 하나로 나가 Shopify의 IP 기준 카트 rate limit을 전 사용자가 공유 →
// 상시 THROTTLED되어 리스트/상세에서 할인이 잡히지 않았다. 할인 "표시"는 카트 버킷과
// 무관한 Admin API(`/api/automatic-discounts`)로 조회한다. (실제 할인 적용은 체크아웃
// 시 Shopify가 서버에서 수행하므로 이 변경은 표시 계층에만 영향.)
export interface AutomaticDiscountData {
  productMap: Record<string, number>; // productId(gid) → 할인율(%)
  allItemsPercentage: number;         // 전상품 대상 자동할인 중 최대 %
}

const _EMPTY_DISCOUNTS: AutomaticDiscountData = { productMap: {}, allItemsPercentage: 0 };
let _autoDiscountPromise: Promise<AutomaticDiscountData> | null = null;
let _autoDiscountAt = 0;
const _AUTO_DISCOUNT_TTL = 5 * 60 * 1000; // 5분 (엔드포인트도 10분 캐시)

// 전 소비자(리스트·상세)가 하나의 조회를 공유한다. 실패 시 빈 맵 → 정가로 degrade.
export async function fetchAutomaticDiscountData(): Promise<AutomaticDiscountData> {
  const now = Date.now();
  if (_autoDiscountPromise && now - _autoDiscountAt < _AUTO_DISCOUNT_TTL) {
    return _autoDiscountPromise;
  }
  _autoDiscountAt = now;
  _autoDiscountPromise = (async () => {
    try {
      const res = await fetch('/api/automatic-discounts');
      if (!res.ok) return _EMPTY_DISCOUNTS;
      const data = await res.json();
      return {
        productMap: data?.productMap || {},
        allItemsPercentage: data?.allItemsPercentage || 0,
      };
    } catch {
      return _EMPTY_DISCOUNTS;
    }
  })();
  return _autoDiscountPromise;
}

// 특정 상품의 자동 할인율(%). 상품별 할인과 전상품 할인 중 큰 값.
export function discountPercentForProduct(data: AutomaticDiscountData, productId: string): number {
  return Math.max(data.productMap[productId] || 0, data.allItemsPercentage);
}

/**
 * 상품별 자동 할인율(%) 맵을 반환한다. (drop-in: 기존 cartCreate 방식 대체)
 * Admin API로 조회한 자동 할인 맵에서 요청한 상품만 골라 반환한다.
 */
export async function fetchProductDiscounts(
  reps: { productId: string; variantId: string }[]
): Promise<Record<string, number>> {
  const data = await fetchAutomaticDiscountData();
  const result: Record<string, number> = {};
  for (const r of reps) {
    const pct = discountPercentForProduct(data, r.productId);
    if (pct > 0) result[r.productId] = pct;
  }
  return result;
}

// Collections
export interface ShopifyCollection {
  id: string;
  title: string;
  handle: string;
  description: string;
  image: {
    url: string;
    altText: string | null;
  } | null;
}

const GET_COLLECTIONS_QUERY = `
  query GetCollections($first: Int!) {
    collections(first: $first, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          description
          image {
            url
            altText
          }
        }
      }
    }
  }
`;

// Navigation Menu (supports nested category depth from Shopify theme)
export interface ShopifyMenuItem {
  id: string;
  title: string;
  url: string;
  type: string;
  resourceId: string | null;
  items: ShopifyMenuItem[];
}

export interface ShopifyMenu {
  id: string;
  handle: string;
  title: string;
  items: ShopifyMenuItem[];
}

const GET_MENU_QUERY = `
  query GetMenu($handle: String!) {
    menu(handle: $handle) {
      id
      handle
      title
      items {
        id
        title
        url
        type
        resourceId
        items {
          id
          title
          url
          type
          resourceId
          items {
            id
            title
            url
            type
            resourceId
            items {
              id
              title
              url
              type
              resourceId
            }
          }
        }
      }
    }
  }
`;

const GET_COLLECTION_PRODUCTS_QUERY = `
  query GetCollectionProducts($handle: String!, $first: Int!, $after: String) {
    collection(handle: $handle) {
      id
      title
      handle
      products(first: $first, after: $after, sortKey: COLLECTION_DEFAULT) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            description
            handle
            productType
            tags
            vendor
            priceRange {
              minVariantPrice {
                amount
                currencyCode
              }
            }
            images(first: 5) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price {
                    amount
                    currencyCode
                  }
                  compareAtPrice {
                    amount
                    currencyCode
                  }
                  availableForSale
                  image {
                    url
                    altText
                  }
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
            options {
              name
              values
            }
          }
        }
      }
    }
  }
`;

const GET_BEST_SELLING_PRODUCTS_QUERY = `
  query GetBestSellingProducts($first: Int!) {
    products(first: $first, sortKey: BEST_SELLING) {
      edges {
        node {
          id
          title
          handle
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          images(first: 1) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price {
                  amount
                  currencyCode
                }
                compareAtPrice {
                  amount
                  currencyCode
                }
                availableForSale
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          tags
          options {
            name
            values
          }
        }
      }
    }
  }
`;

export async function fetchBestSellingProducts(first: number = 8): Promise<ShopifyProduct[]> {
  const data = await storefrontApiRequest(GET_BEST_SELLING_PRODUCTS_QUERY, { first });
  if (!data) return [];
  return data.data?.products?.edges || [];
}

const GET_NEW_PRODUCTS_QUERY = `
  query GetNewProducts($first: Int!) {
    products(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          images(first: 1) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price {
                  amount
                  currencyCode
                }
                compareAtPrice {
                  amount
                  currencyCode
                }
                availableForSale
                quantityAvailable
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          tags
          options {
            name
            values
          }
        }
      }
    }
  }
`;

export async function fetchNewProducts(first: number = 8): Promise<ShopifyProduct[]> {
  const data = await storefrontApiRequest(GET_NEW_PRODUCTS_QUERY, { first });
  if (!data) return [];
  return data.data?.products?.edges || [];
}

// Banners (Metaobjects)
export interface ShopifyBanner {
  id: string;
  handle: string;
  image: { url: string; altText: string | null } | null;
  linkUrl: string | null;
  fields: Record<string, string>;
}

const GET_BANNERS_QUERY = `
  query GetBanners($first: Int!) {
    metaobjects(type: "2603", first: $first) {
      edges {
        node {
          id
          handle
          fields {
            key
            value
            type
            reference {
              ... on MediaImage {
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    }
  }
`;


export async function fetchBanners(first: number = 10): Promise<ShopifyBanner[]> {
  const data = await storefrontApiRequest(GET_BANNERS_QUERY, { first });
  if (!data) return [];

  return (data.data?.metaobjects?.edges || []).map((edge: any) => {
    const node = edge.node;
    const fields: Record<string, string> = {};
    let image: { url: string; altText: string | null } | null = null;

    let linkUrl: string | null = null;

    for (const field of node.fields) {
      if (field.reference?.image) {
        image = field.reference.image;
      }
      if (field.type === 'link' && field.value) {
        try {
          const parsed = JSON.parse(field.value);
          linkUrl = parsed.url || null;
        } catch {
          linkUrl = null;
        }
      } else if (field.value) {
        fields[field.key] = field.value;
      }
    }

    return { id: node.id, handle: node.handle, image, linkUrl, fields };
  }).sort((a, b) => {
    const aOrder = parseInt(a.fields['sort_order'] ?? '9999', 10);
    const bOrder = parseInt(b.fields['sort_order'] ?? '9999', 10);
    return aOrder - bOrder;
  });
}

export interface ProductsResponse {
  products: ShopifyProduct[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

// API Functions
export async function fetchProducts(first: number = 20, query?: string, after?: string): Promise<ProductsResponse> {
  const data = await storefrontApiRequest(GET_PRODUCTS_QUERY, { first, query, after });
  if (!data) return { products: [], pageInfo: { hasNextPage: false, endCursor: null } };

  const productsData = data.data?.products;
  return {
    products: productsData?.edges || [],
    pageInfo: productsData?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}

// Fetch total product count (fast query with minimal data)
export async function fetchProductCount(query?: string): Promise<number> {
  let totalCount = 0;
  let hasNextPage = true;
  let after: string | undefined = undefined;

  // Note: Shopify Storefront API doesn't have a direct count endpoint
  // We fetch minimal data (just IDs) to count products quickly
  // For large catalogs, this may still take time
  while (hasNextPage) {
    const data = await storefrontApiRequest(GET_PRODUCTS_COUNT_QUERY, { query });
    if (!data) return 0;

    const productsData = data.data?.products;
    totalCount += productsData?.edges?.length || 0;
    hasNextPage = productsData?.pageInfo?.hasNextPage || false;

    // If there are more pages, we'd need to paginate, but for now
    // we'll return the count we have (max 250 for first page)
    // This is a limitation of Storefront API
    if (hasNextPage) {
      // For accurate count, we'd need to paginate through all
      // but that would be slow, so we return what we have
      // and indicate there are more with a "+"
      return totalCount; // Return partial count for now
    }
  }

  return totalCount;
}

export async function fetchProductByHandle(handle: string): Promise<ShopifyProduct['node'] | null> {
  const data = await storefrontApiRequest(GET_PRODUCT_BY_HANDLE_QUERY, { handle });
  if (!data) return null;
  return data.data?.productByHandle || null;
}

const GET_PRODUCT_BY_ID_QUERY = `
  query GetProductById($id: ID!) {
    node(id: $id) {
      ... on Product {
        id
        title
        description
        descriptionHtml
        handle
        productType
        tags
        vendor
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
        images(first: 20) {
          edges {
            node {
              url
              altText
            }
          }
        }
        variants(first: 50) {
          edges {
            node {
              id
              title
              price {
                amount
                currencyCode
              }
              compareAtPrice {
                amount
                currencyCode
              }
              availableForSale
              quantityAvailable
              image {
                url
                altText
              }
              selectedOptions {
                name
                value
              }
            }
          }
        }
        options {
          name
          values
        }
      }
    }
  }
`;

export async function fetchProductById(numericId: string): Promise<ShopifyProduct['node'] | null> {
  const id = `gid://shopify/Product/${numericId}`;
  const data = await storefrontApiRequest(GET_PRODUCT_BY_ID_QUERY, { id });
  if (!data) return null;
  return data.data?.node || null;
}

export async function fetchCollections(first: number = 20): Promise<ShopifyCollection[]> {
  const data = await storefrontApiRequest(GET_COLLECTIONS_QUERY, { first });
  if (!data) return [];
  return data.data?.collections?.edges?.map((e: { node: ShopifyCollection }) => e.node) || [];
}

// Fetch navigation menu by handle (e.g., "main-menu", "footer")
export async function fetchMenu(handle: string = "main-menu"): Promise<ShopifyMenu | null> {
  const data = await storefrontApiRequest(GET_MENU_QUERY, { handle });
  if (!data) return null;
  return data.data?.menu || null;
}

// Extract collection handle from a Shopify menu item URL
export function extractHandleFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    // /collections/some-handle → "some-handle"
    if (pathParts.length >= 2 && pathParts[0] === 'collections') {
      return decodeURIComponent(pathParts[1]);
    }
    // /products/some-handle → "some-handle" (for product links)
    if (pathParts.length >= 2 && pathParts[0] === 'products') {
      return decodeURIComponent(pathParts[1]);
    }
    return null;
  } catch {
    return null;
  }
}

export interface CollectionProductsResponse extends ProductsResponse {
  collectionTitle: string | null;
}

export async function fetchCollectionProducts(handle: string, first: number = 20, after?: string): Promise<CollectionProductsResponse> {
  const data = await storefrontApiRequest(GET_COLLECTION_PRODUCTS_QUERY, { handle, first, after });
  if (!data) return { products: [], pageInfo: { hasNextPage: false, endCursor: null }, collectionTitle: null };

  const collection = data.data?.collection;
  if (!collection) return { products: [], pageInfo: { hasNextPage: false, endCursor: null }, collectionTitle: null };

  return {
    products: collection.products?.edges || [],
    pageInfo: collection.products?.pageInfo || { hasNextPage: false, endCursor: null },
    collectionTitle: collection.title || null,
  };
}

export async function createStorefrontCheckout(items: { variantId: string; quantity: number }[], formEmail?: string): Promise<string> {
  const affiliateDiscount = localStorage.getItem('affiliate_discount');
  return createStorefrontCheckoutWithDiscount(items, affiliateDiscount, formEmail);
}

 // Create checkout with optional discount code for B2B members
 export async function createStorefrontCheckoutWithDiscount(
   items: { variantId: string; quantity: number }[],
   discountCodes: string | string[] | null,
   formEmail?: string
 ): Promise<string> {
  const lines = items.map(item => ({
    quantity: item.quantity,
    merchandiseId: item.variantId,
  }));

   // Build cart input with buyer identity if logged in
   const input: Record<string, unknown> = { lines };
   const codes = Array.isArray(discountCodes)
     ? discountCodes.filter(Boolean)
     : discountCodes ? [discountCodes] : [];
   if (codes.length > 0) {
     input.discountCodes = codes;
   }

   // Attach buyer identity — always refresh token before checkout
   const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
   let customerToken: string | undefined;
   try {
     const authData = JSON.parse(localStorage.getItem('line-auth') || '{}');
     const user = authData?.state?.user;

     if (user?.lineSessionToken && user?.shopifyEmail) {
       // 체크아웃 직전 토큰 갱신 → 만료 문제 방지
       try {
         const refreshRes = await fetch('/api/refresh-customer-token', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ lineSessionToken: user.lineSessionToken, shopifyEmail: user.shopifyEmail }),
         });
         if (refreshRes.ok) {
           const refreshData = await refreshRes.json();
           customerToken = refreshData.customerAccessToken;
           // store에도 반영 (비동기, 실패해도 무시)
           try {
             const { useAuthStore } = await import('@/stores/authStore');
             useAuthStore.getState().updateCustomerToken(customerToken!);
           } catch { /* ignore */ }
         }
       } catch { /* 갱신 실패 시 기존 토큰 사용 */ }
     }

     // 갱신 실패 시 기존 토큰 fallback
     if (!customerToken) {
       customerToken = user?.shopifyCustomerToken;
     }

     if (customerToken) {
       // customerAccessToken만 사용 — 이메일 지정 금지 (충돌 방지)
       input.buyerIdentity = {
         customerAccessToken: customerToken,
         countryCode: 'JP',
       };
     } else {
       // 로그아웃 상태: formEmail만 사용
       const fallbackEmail = formEmail && isValidEmail(formEmail) ? formEmail : undefined;
       if (fallbackEmail) {
         input.buyerIdentity = { email: fallbackEmail, countryCode: 'JP' };
       }
     }
   } catch { /* continue without buyer identity */ }

   // GA4 어트리뷰션용 카트 속성 추가
  // Shopify thank-you 페이지의 Customer Events 픽셀에서 참조하여 purchase 이벤트 발동
  const trackingAttributes: { key: string; value: string }[] = [];
  try {
    const savedUtm = sessionStorage.getItem('_bm_utm');
    if (savedUtm) {
      const utmData = JSON.parse(savedUtm) as Record<string, string>;
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(k => {
        if (utmData[k]) trackingAttributes.push({ key: k, value: utmData[k] });
      });
    }
  } catch { /* ignore */ }
  const [clientId, sessionId] = await Promise.all([getGA4ClientId(), getGA4SessionId()]);
  if (clientId) trackingAttributes.push({ key: 'ga_client_id', value: clientId });
  if (sessionId) trackingAttributes.push({ key: 'ga_session_id', value: sessionId });
  if (trackingAttributes.length > 0) input.attributes = trackingAttributes;

  let data = await storefrontApiRequest(CART_CREATE_MUTATION, { input });

   // If customer token is expired/invalid, retry without it
   const tokenError = data?.data?.cartCreate?.userErrors?.some(
     (e: { field: string[]; message: string }) =>
       e.field?.includes('customerAccessToken') || e.message?.includes('無効')
   );
   if (tokenError || !data?.data?.cartCreate?.cart) {
     console.warn('[Checkout] Customer token invalid or cart null, retrying');
     if (tokenError && formEmail && isValidEmail(formEmail)) {
       // token失効 → メールのみで再試行
       input.buyerIdentity = { email: formEmail, countryCode: 'JP' };
     } else {
       // cartがnull (既存顧客メールで弾かれた等) → buyerIdentity完全削除
       delete input.buyerIdentity;
     }
     data = await storefrontApiRequest(CART_CREATE_MUTATION, { input });
   }

   // If email is still causing issues, retry without buyer identity
   const emailError = data?.data?.cartCreate?.userErrors?.some(
     (e: { message: string }) => e.message?.includes('Email') || e.message?.includes('email')
   );
   if (emailError) {
     console.warn('[Checkout] Email invalid, retrying without buyer identity');
     delete input.buyerIdentity;
     data = await storefrontApiRequest(CART_CREATE_MUTATION, { input });
   }

  if (!data) {
    throw new Error('Failed to create checkout');
  }

  if (data.data.cartCreate.userErrors.length > 0) {
    throw new Error(`Cart creation failed: ${data.data.cartCreate.userErrors.map((e: { message: string }) => e.message).join(', ')}`);
  }

  const cart = data.data.cartCreate.cart;

  if (!cart.checkoutUrl) {
    throw new Error('No checkout URL returned from Shopify');
  }

  const url = new URL(cart.checkoutUrl);
  url.searchParams.set('channel', 'online_store');

  if (codes.length > 0) {
    url.searchParams.set('discount', codes[0]);
    localStorage.removeItem('affiliate_discount');
  }

  // Add return URL for post-checkout redirect
  const returnUrl = `${window.location.origin}/checkout-return`;
  url.searchParams.set('return_to', returnUrl);

  return url.toString();
}

// Customer data - fetch using Shopify Customer Access Token
export interface ShopifyOrder {
  id: string;
  orderNumber: number;
  name: string;
  processedAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  totalPrice: { amount: string; currencyCode: string };
  statusUrl: string | null;
  shippingAddress: { city?: string; province?: string; country?: string } | null;
  fulfillments: Array<{ trackingCompany: string | null; trackingNumber: string | null; trackingUrl: string | null }>;
  lineItems: Array<{
    title: string;
    quantity: number;
    variant?: { image?: { url: string } } | null;
  }>;
}

export interface ShopifyCustomerProfile {
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  numberOfOrders: string;
  createdAt: string;
  acceptsMarketing: boolean;
  defaultAddress: {
    address1: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  orders: ShopifyOrder[];
}

const GET_CUSTOMER_DATA_QUERY = `
  query GetCustomerData($customerAccessToken: String!) {
    customer(customerAccessToken: $customerAccessToken) {
      displayName
      firstName
      lastName
      email
      phone
      numberOfOrders
      createdAt
      acceptsMarketing
      defaultAddress {
        address1
        city
        province
        zip
        country
      }
      orders(first: 20, sortKey: PROCESSED_AT, reverse: true) {
        edges {
          node {
            id
            orderNumber
            name
            processedAt
            financialStatus
            fulfillmentStatus
            statusUrl
            shippingAddress {
              city
              province
              country
            }
            successfulFulfillments(first: 5) {
              trackingCompany
              trackingInfo(first: 5) {
                number
                url
              }
            }
            totalPrice {
              amount
              currencyCode
            }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    image {
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export async function fetchCustomerData(customerAccessToken: string): Promise<ShopifyCustomerProfile | null> {
  const data = await storefrontApiRequest(GET_CUSTOMER_DATA_QUERY, { customerAccessToken });
  if (!data || !data.data?.customer) return null;

  const c = data.data.customer;
  return {
    displayName: c.displayName,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    numberOfOrders: c.numberOfOrders,
    createdAt: c.createdAt,
    acceptsMarketing: c.acceptsMarketing,
    defaultAddress: c.defaultAddress,
    orders: (c.orders?.edges || []).map((edge: any) => {
      const node = edge.node;
      const fulfillments = (node.successfulFulfillments || []).map((f: any) => ({
        trackingCompany: f.trackingCompany,
        trackingNumber: f.trackingInfo?.[0]?.number || null,
        trackingUrl: f.trackingInfo?.[0]?.url || null,
      }));
      return {
        id: node.id,
        orderNumber: node.orderNumber,
        name: node.name,
        processedAt: node.processedAt,
        financialStatus: node.financialStatus,
        fulfillmentStatus: node.fulfillmentStatus,
        statusUrl: node.statusUrl,
        shippingAddress: node.shippingAddress,
        fulfillments,
        totalPrice: node.totalPrice,
        lineItems: (node.lineItems?.edges || []).map((li: any) => ({
          title: li.node.title,
          quantity: li.node.quantity,
          variant: li.node.variant,
        })),
      };
    }),
  };
}

const PRODUCT_RECOMMENDATIONS_QUERY = `
  query ProductRecommendations($productId: ID!) {
    productRecommendations(productId: $productId) {
      id
      title
      handle
      priceRange {
        minVariantPrice { amount currencyCode }
      }
      images(first: 1) {
        edges { node { url altText } }
      }
    }
  }
`;

export interface ProductRecommendation {
  id: string;
  title: string;
  handle: string;
  price: { amount: string; currencyCode: string };
  imageUrl: string | null;
  imageAlt: string | null;
}

export async function fetchProductRecommendations(productId: string): Promise<ProductRecommendation[]> {
  const data = await storefrontApiRequest(PRODUCT_RECOMMENDATIONS_QUERY, { productId });
  return (data?.data?.productRecommendations || []).map((p: {
    id: string; title: string; handle: string;
    priceRange: { minVariantPrice: { amount: string; currencyCode: string } };
    images: { edges: Array<{ node: { url: string; altText: string | null } }> };
  }) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    price: p.priceRange.minVariantPrice,
    imageUrl: p.images.edges[0]?.node.url || null,
    imageAlt: p.images.edges[0]?.node.altText || p.title,
  }));
}

// Backward compat
export async function fetchCustomerOrders(customerAccessToken: string): Promise<ShopifyOrder[]> {
  const profile = await fetchCustomerData(customerAccessToken);
  return profile?.orders || [];
}

/**
 * Admin API 経由で顧客の注文を取得（Storefront API の customer クエリ deprecation 対策）
 */
/**
 * ⚠️ 고객 ID·LINE userId 를 직접 넘기지 않는다. 서버는 서명된 lineSessionToken
 *    (또는 Storefront customerAccessToken)에서만 조회 대상을 정한다.
 */
export async function fetchCustomerOrdersViaAdmin(
  customerAccessToken: string | null | undefined,
  lineSessionToken?: string,
): Promise<ShopifyOrder[]> {
  const res = await fetch('/api/customer-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerAccessToken, lineSessionToken }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.orders || [];
}

// Shipping rates - fetch from Shopify delivery profiles
export interface ShippingRate {
  title: string;
  amount: string;
  currencyCode: string;
}

export async function fetchShippingRates(
  countryCode: string = "JP",
  lineItems?: Array<{ variantId: string; quantity: number }>
): Promise<ShippingRate[]> {
  let cartLines: Array<{ quantity: number; merchandiseId: string }>;

  if (lineItems && lineItems.length > 0) {
    // Use actual cart items so shipping rate reflects the real products
    cartLines = lineItems.map((item) => ({ quantity: item.quantity, merchandiseId: item.variantId }));
  } else {
    // Fallback: use the first available product variant
    const productsData = await storefrontApiRequest(GET_PRODUCTS_QUERY, { first: 1 });
    if (!productsData) return [];
    const variant = productsData.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node;
    if (!variant) return [];
    cartLines = [{ quantity: 1, merchandiseId: variant.id }];
  }

  // Create cart with the resolved line items
  const cartData = await storefrontApiRequest(CART_CREATE_MUTATION, {
    input: { lines: cartLines },
  });
  if (!cartData) return [];

  const cartId = cartData.data?.cartCreate?.cart?.id;
  if (!cartId) return [];

  // Step 3: Update buyer identity with country to get delivery options
  const CART_BUYER_IDENTITY_UPDATE = `
    mutation cartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
      cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
        cart {
          deliveryGroups(first: 10) {
            edges {
              node {
                deliveryOptions {
                  title
                  estimatedCost {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const deliveryData = await storefrontApiRequest(CART_BUYER_IDENTITY_UPDATE, {
    cartId,
    buyerIdentity: {
      countryCode,
      deliveryAddressPreferences: [{
        deliveryAddress: {
          country: countryCode,
          zip: '100-0001',
          city: '千代田区',
          province: '東京都',
        },
      }],
    },
  });

  if (!deliveryData) return [];

  const groups = deliveryData.data?.cartBuyerIdentityUpdate?.cart?.deliveryGroups?.edges || [];
  const rates: ShippingRate[] = [];

  for (const group of groups) {
    for (const option of group.node.deliveryOptions || []) {
      rates.push({
        title: option.title,
        amount: option.estimatedCost.amount,
        currencyCode: option.estimatedCost.currencyCode,
      });
    }
  }

  return rates;
}

// Format price helper
export function formatPrice(amount: string, currencyCode: string): string {
  const numAmount = parseFloat(amount);

  // Use appropriate locale based on currency
  const localeMap: Record<string, string> = {
    'JPY': 'ja-JP',
    'USD': 'en-US',
    'CAD': 'en-CA',
    'KRW': 'ko-KR',
    'HKD': 'en-HK',
    'SGD': 'en-SG',
    'EUR': 'en-IE',
    'GBP': 'en-GB',
  };

  const locale = localeMap[currencyCode] || 'ja-JP';

  const noDecimalCurrencies = ['KRW', 'JPY'];
  const useNoDecimals = noDecimalCurrencies.includes(currencyCode);

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: useNoDecimals ? 0 : 2,
    maximumFractionDigits: useNoDecimals ? 0 : 2,
  }).format(numAmount);
}
