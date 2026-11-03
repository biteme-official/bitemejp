/**
 * `coupon_used:<코드>` 태그 백필 (일회성, #242)
 *
 * 장바구니 「LINE会員クーポン 約 -¥」 줄은 이 태그가 없는 사람에게만 보인다.
 * 신규 사용은 주문 웹훅(api/shopify-purchase-webhook.ts tagCouponUsed)이 달고,
 * 그 이전에 WELCOME10 · LINKUP10 을 쓴 고객에게는 이 스크립트로 한 번 단다.
 *
 * ⚠️ 사이트의 REPORT 앱은 read_all_orders 가 없어 최근 60일 주문만 보인다(에러 없이).
 *    전체 기간을 보려면 read_all_orders + write_customers 가 있는 Admin 토큰을 넘겨야 한다.
 *
 * 사용법:
 *   ALL_ORDERS_ADMIN_TOKEN=shpat_... npx tsx scripts/backfill-coupon-used-tags.ts          # 미리보기
 *   ALL_ORDERS_ADMIN_TOKEN=shpat_... npx tsx scripts/backfill-coupon-used-tags.ts --apply  # 실제 반영
 *
 * tagsAdd 는 기존 태그를 건드리지 않고 이미 있는 태그는 무시한다 — 여러 번 돌려도 안전하다.
 */
import { SHOPIFY_API_VERSION } from '../api/_shopify-api-version.js';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
const TOKEN = process.env.ALL_ORDERS_ADMIN_TOKEN;
const APPLY = process.argv.includes('--apply');
/** api/shopify-purchase-webhook.ts COUPON_USED_CODES 와 같아야 한다 */
const CODES = ['WELCOME10', 'LINKUP10'];

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN! },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    const throttled = json?.errors?.some?.((e: { extensions?: { code?: string } }) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 5) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data as T;
  }
}

interface OrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: { name: string; discountCodes: string[]; customer: { id: string; tags: string[] } | null } }>;
  };
}

async function main() {
  if (!TOKEN) throw new Error('ALL_ORDERS_ADMIN_TOKEN 이 필요하다 (read_all_orders + write_customers)');

  // 고객 GID → 달아야 할 태그
  const want = new Map<string, Set<string>>();
  let orders = 0;
  let noCustomer = 0;
  let cursor: string | null = null;
  do {
    const data: OrdersPage = await gql<OrdersPage>(`
      query Orders($q: String!, $cursor: String) {
        orders(first: 250, after: $cursor, query: $q) {
          pageInfo { hasNextPage endCursor }
          edges { node { name discountCodes customer { id tags } } }
        }
      }
    `, { q: CODES.map((c) => `discount_code:${c}`).join(' OR '), cursor });
    for (const { node } of data.orders.edges) {
      orders++;
      if (!node.customer) { noCustomer++; continue; }
      const have = new Set(node.customer.tags);
      for (const code of node.discountCodes.map((c) => c.toUpperCase()).filter((c) => CODES.includes(c))) {
        const tag = `coupon_used:${code}`;
        if (have.has(tag)) continue;
        if (!want.has(node.customer.id)) want.set(node.customer.id, new Set());
        want.get(node.customer.id)!.add(tag);
      }
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  const byTag = new Map<string, number>();
  for (const tags of want.values()) for (const t of tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
  console.log(`쿠폰 사용 주문 ${orders}건 (고객 없음 ${noCustomer}건) → 태그 달 고객 ${want.size}명`);
  for (const [t, n] of byTag) console.log(`  ${t}: ${n}명`);

  if (!APPLY) { console.log('\n미리보기만 했다. 반영하려면 --apply'); return; }

  let ok = 0;
  let failed = 0;
  for (const [id, tags] of want) {
    const r = await gql<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(`
      mutation Tag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }
    `, { id, tags: [...tags] });
    if (r.tagsAdd.userErrors.length) { failed++; console.error(`  🔴 ${id}:`, r.tagsAdd.userErrors); } else ok++;
    if ((ok + failed) % 100 === 0) console.log(`  … ${ok + failed}/${want.size}`);
  }
  console.log(`완료: 성공 ${ok} · 실패 ${failed}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
