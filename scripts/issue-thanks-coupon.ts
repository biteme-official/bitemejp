/**
 * 블프 첫 구매자 「두 번째 구매 ¥500」 쿠폰 미리 발급 (#320)
 *
 * 대상 = 블프 기간(11/9 10:00 ~ 11/22) 안에 **첫 주문**을 한 고객.
 *        취소·환불·테스트 주문, test 태그 고객은 뺀다(japan-mall-retro 블프 회고와 같은 정의).
 * 하는 일 = 사람마다 코드 THX500-XXXXXXXXXX 생성(이미 있으면 건너뜀) + 고객 태그 `thanks500` 부착.
 *
 * 사용법:
 *   npx tsx scripts/issue-thanks-coupon.ts          # 미리보기 — 인원만 센다. 쓰기 없음
 *   npx tsx scripts/issue-thanks-coupon.ts --apply  # 실제 발급
 *   npx tsx scripts/issue-thanks-coupon.ts --update-dates  # 이미 만든 코드의 기간을 api/_thanks-coupon.ts 값으로 맞춤
 *
 * 여러 번 돌려도 안전하다 — 코드는 고객 id 로 정해지고 있으면 건너뛰며, 태그 추가도 중복되지 않는다.
 * 출력에는 고객 id·이메일 같은 개인 정보를 찍지 않는다(숫자만).
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env.production') });
config({ path: join(__dirname, '..', '.env') });

const { adminGraphQL, getAdminToken } = await import('../api/line-campaign.js');
const { BF_END, BF_START, THANKS_ENDS_AT, THANKS_STARTS_AT, THANKS_TAG, THANKS_TITLE_PREFIX, createThanksCode, findThanksCode, thanksCodeFor } = await import(
  '../api/_thanks-coupon.js'
);

const APPLY = process.argv.includes('--apply');
const UPDATE_DATES = process.argv.includes('--update-dates');
const PLACEHOLDER_EMAIL_DOMAIN = '@line-user.biteme.co.jp';
/**
 * REPORT 앱엔 read_all_orders 가 없어 최근 60일 주문만 보인다. 그래서 「첫 주문」은 두 가지로 판정한다:
 *   ① 보이는 주문 중 가장 이른 (유효) 주문이 블프 기간 안
 *   ② 고객의 평생 주문 수(numberOfOrders) ≤ 보이는 주문 수(상태 무관) — 넘으면 60일 전에 산 적이 있다
 * 블프 시작이 60일 창 안에 있어야 한다(12/1 전후 실행 기준 충분).
 */
const WINDOW_DAYS = 59;

interface OrderNode {
  createdAt: string;
  cancelledAt: string | null;
  test: boolean;
  displayFinancialStatus: string | null;
  customer: { id: string; tags: string[]; email: string | null; numberOfOrders: string } | null;
}

type GqlResult<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 비용 한도(THROTTLED)에 걸리면 잠깐 쉬고 다시 */
async function gql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> {
  for (let attempt = 0; ; attempt++) {
    const r = await adminGraphQL<GqlResult<T>>(token, query, variables);
    const throttled = r.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if (!throttled || attempt >= 5) return r;
    await sleep(2000 * (attempt + 1));
  }
}

async function checkScopes(token: string): Promise<void> {
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN;
  const res = await fetch(`https://${shop}/admin/oauth/access_scopes.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const scopes = ((await res.json()) as { access_scopes?: { handle: string }[] }).access_scopes?.map((s) => s.handle) ?? [];
  const need = ['read_orders', 'write_discounts', 'write_customers'];
  const missing = need.filter((s) => !scopes.includes(s));
  if (missing.length) {
    console.error(`🔴 스코프 부족: ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function fetchOrders(token: string): Promise<OrderNode[]> {
  const out: OrderNode[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const r: GqlResult<{
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: OrderNode[] };
    }> = await gql(
      token,
      `query($cursor: String, $q: String) {
        orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes { createdAt cancelledAt test displayFinancialStatus customer { id tags email numberOfOrders } }
        }
      }`,
      { cursor, q: `created_at:>=${new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)}` },
    );
    if (!r.data) throw new Error(`주문 조회 실패: ${JSON.stringify(r.errors).slice(0, 300)}`);
    out.push(...r.data.orders.nodes);
    if (!r.data.orders.pageInfo.hasNextPage) break;
    cursor = r.data.orders.pageInfo.endCursor;
  }
  return out;
}

function isExcluded(o: OrderNode): boolean {
  if (o.test || o.cancelledAt) return true;
  const fs = (o.displayFinancialStatus ?? '').toUpperCase();
  if (fs === 'REFUNDED' || fs === 'VOIDED') return true;
  return (o.customer?.tags ?? []).some((t) => /^test2?$/i.test(t.trim()));
}

/** 이미 만든 코드(제목 접두어로 찾음)의 시작·종료를 지금 상수로 맞춘다 */
async function updateDates(token: string): Promise<void> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const r: GqlResult<{
      codeDiscountNodes: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { id: string; codeDiscount: { title?: string; startsAt?: string; endsAt?: string } | null }[];
      };
    }> = await gql(
      token,
      `query($a: String) {
        codeDiscountNodes(first: 250, after: $a, query: "title:'${THANKS_TITLE_PREFIX}*'") {
          pageInfo { hasNextPage endCursor }
          nodes { id codeDiscount { ... on DiscountCodeBasic { title startsAt endsAt } } }
        }
      }`,
      { a: after },
    );
    if (!r.data) throw new Error(`코드 목록 실패: ${JSON.stringify(r.errors).slice(0, 300)}`);
    for (const n of r.data.codeDiscountNodes.nodes) {
      const d = n.codeDiscount;
      if (!d?.title?.startsWith(THANKS_TITLE_PREFIX)) continue;
      const same = Date.parse(d.startsAt ?? '') === Date.parse(THANKS_STARTS_AT) && Date.parse(d.endsAt ?? '') === Date.parse(THANKS_ENDS_AT);
      if (!same) ids.push(n.id);
    }
    if (!r.data.codeDiscountNodes.pageInfo.hasNextPage) break;
    after = r.data.codeDiscountNodes.pageInfo.endCursor;
  }
  console.log(`기간이 다른 코드 ${ids.length}건 → ${THANKS_STARTS_AT} ~ ${THANKS_ENDS_AT}`);
  let ok = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const r = await gql<{ discountCodeBasicUpdate: { userErrors: { message: string }[] } }>(
      token,
      `mutation($id: ID!, $d: DiscountCodeBasicInput!) {
        discountCodeBasicUpdate(id: $id, basicCodeDiscount: $d) { userErrors { message } }
      }`,
      { id, d: { startsAt: THANKS_STARTS_AT, endsAt: THANKS_ENDS_AT } },
    );
    const errs = r.data?.discountCodeBasicUpdate.userErrors ?? [];
    if (!r.data || errs.length) failed.push(errs.map((e) => e.message).join('/') || JSON.stringify(r.errors).slice(0, 120));
    else ok++;
    if ((ok + failed.length) % 100 === 0) console.log(`  … ${ok + failed.length}/${ids.length}`);
  }
  console.log(`기간 수정 완료 ${ok} · 실패 ${failed.length}`);
  if (failed.length) {
    console.log('실패 사유(앞 5건):', failed.slice(0, 5));
    process.exit(1);
  }
}

async function main() {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) throw new Error('LINE_CHANNEL_SECRET 미설정');
  const token = await getAdminToken();
  await checkScopes(token);
  if (UPDATE_DATES) return updateDates(token);

  const all = await fetchOrders(token);
  const bf0 = Date.parse(BF_START);
  const bf1 = Date.parse(BF_END);
  if (Date.now() - WINDOW_DAYS * 86_400_000 > bf0) throw new Error('블프 시작이 조회 창(60일) 밖입니다 — 첫 주문 판정 불가');

  // 상태 무관 보이는 주문 수 (평생 주문 수와 비교용)
  const visible = new Map<string, number>();
  for (const o of all) if (o.customer) visible.set(o.customer.id, (visible.get(o.customer.id) ?? 0) + 1);

  // 고객별 첫 (유효) 주문
  const orders = all.filter((o) => !isExcluded(o) && o.customer);
  const first = new Map<string, { t: number; tags: string[]; email: string | null; lifetime: number }>();
  for (const o of orders) {
    const c = o.customer!;
    const t = Date.parse(o.createdAt);
    const prev = first.get(c.id);
    if (!prev || t < prev.t) first.set(c.id, { t, tags: c.tags, email: c.email, lifetime: Number(c.numberOfOrders) });
  }
  const inBf = [...first].filter(([, v]) => v.t >= bf0 && v.t <= bf1);
  const targets = inBf.filter(([gid, v]) => v.lifetime <= (visible.get(gid) ?? 0));
  console.log(`60일 전 구매 이력이 있어 뺀 사람 ${inBf.length - targets.length}명`);

  const line = targets.filter(([, v]) => v.tags.includes('line_member')).length;
  const realEmail = targets.filter(([, v]) => v.email && !v.email.endsWith(PLACEHOLDER_EMAIL_DOMAIN)).length;
  const tagged = targets.filter(([, v]) => v.tags.includes(THANKS_TAG)).length;
  console.log(`주문 ${orders.length}건 · 블프 첫 구매자 ${targets.length}명 (LINE 연결 ${line} · 실제 이메일 ${realEmail} · 이미 태그 ${tagged})`);

  if (!APPLY) {
    console.log('미리보기만 했습니다. 실제 발급은 --apply');
    return;
  }

  let created = 0;
  let existed = 0;
  let tagAdded = 0;
  const failed: string[] = [];
  for (const [gid, v] of targets) {
    try {
      const code = thanksCodeFor(gid, secret);
      if (await findThanksCode(token, code)) existed++;
      else if ((await createThanksCode(token, code, gid)) === 'created') created++;
      else existed++;

      if (!v.tags.includes(THANKS_TAG)) {
        const r = await gql<{ tagsAdd: { userErrors: { message: string }[] } }>(
          token,
          `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { id: gid, tags: [THANKS_TAG] },
        );
        const errs = r.data?.tagsAdd.userErrors ?? [];
        if (!r.data || errs.length) throw new Error(`태그 실패: ${errs.map((e) => e.message).join('/') || JSON.stringify(r.errors)}`);
        tagAdded++;
      }
    } catch (e) {
      failed.push(e instanceof Error ? e.message.slice(0, 120) : String(e));
    }
    const done = created + existed;
    if (done % 50 === 0) console.log(`  … ${done}/${targets.length}`);
  }

  console.log(`완료: 새로 만든 코드 ${created} · 이미 있음 ${existed} · 태그 추가 ${tagAdded} · 실패 ${failed.length}`);
  if (failed.length) {
    console.log('실패 사유(앞 5건):', failed.slice(0, 5));
    process.exit(1);
  }
}

await main();
