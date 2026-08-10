/**
 * `line_member` 공통 태그 백필 (일회성)
 *
 * `line_id:{userId}` 태그는 사람마다 값이 달라 Shopify 고객 세그먼트 조건으로 쓸 수 없다.
 * "LINE 로그인 회원 전체"를 한 조건으로 잡기 위한 공통 태그를 기존 회원에게도 붙인다.
 * (신규 로그인은 api/line-callback.ts 가 자동으로 붙인다)
 *
 * 사용법:
 *   npx tsx scripts/backfill-line-member.ts          # 미리보기 (쓰기 없음)
 *   npx tsx scripts/backfill-line-member.ts --apply  # 실제 반영
 *
 * ⚠️ customerUpdate 의 tags 는 병합이 아니라 전체 교체다. 반드시 기존 태그를 읽어
 *    합쳐서 보낸다. 조회에 실패한 고객은 건너뛴다 — 빈 배열로 덮으면 태그가 전부 날아간다.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env.production') });
config({ path: join(__dirname, '..', '.env') });

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN!;
const API_VERSION = '2025-07';
const MEMBER_TAG = 'line_member';
const PLACEHOLDER_DOMAIN = '@line-user.biteme.co.jp';
const APPLY = process.argv.includes('--apply');

interface Customer {
  id: string;
  email: string | null;
  tags: string[];
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.REPORT_SHOPIFY_CLIENT_ID!,
      client_secret: process.env.REPORT_SHOPIFY_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패: ${res.status}`);
  return (await res.json()).access_token;
}

async function gql(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function main() {
  const token = await getAccessToken();

  const scopeRes = await fetch(`https://${SHOP}/admin/oauth/access_scopes.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const scopes: string[] = (await scopeRes.json()).access_scopes.map((s: { handle: string }) => s.handle);
  if (!scopes.includes('write_customers')) {
    console.error('🔴 write_customers 스코프가 없습니다. 중단합니다.');
    process.exit(1);
  }

  // ⚠️ `tag:'line_id:*'` 같은 와일드카드 태그 검색은 Shopify 에서 동작하지 않는다
  //    (콜론이 든 태그라 0건이 나온다 — 실측 확인). 그 검색에 기대면 실제 이메일을
  //    등록해 자리표시자 주소가 사라진 회원이 통째로 누락된다.
  //    고객 수가 수천 명 규모라 전수를 훑고 클라이언트에서 판정하는 편이 안전하다.
  const all: Customer[] = [];
  let cursor: string | null = null;
  do {
    const data: {
      data?: { customers: { pageInfo: { hasNextPage: boolean; endCursor: string }; edges: { node: Customer }[] } };
      errors?: unknown;
    } = await gql(token, `
      query AllCustomers($cursor: String) {
        customers(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id email tags } }
        }
      }
    `, { cursor });

    if (!data.data) throw new Error(`고객 조회 실패: ${JSON.stringify(data.errors)}`);
    all.push(...data.data.customers.edges.map((e) => e.node));
    cursor = data.data.customers.pageInfo.hasNextPage ? data.data.customers.pageInfo.endCursor : null;
  } while (cursor);

  const targets = all.filter(
    (c) => c.tags.some((t) => t.startsWith('line_id:')) || (c.email ?? '').endsWith(PLACEHOLDER_DOMAIN)
  );
  console.log(`전체 고객 ${all.length}명 중 LINE 회원 ${targets.length}명`);

  const needsTag = targets.filter((c) => !c.tags.includes(MEMBER_TAG));
  console.log(`LINE 회원 ${targets.length}명 / 태그 필요 ${needsTag.length}명 / 이미 보유 ${targets.length - needsTag.length}명`);

  if (!APPLY) {
    console.log('\n미리보기입니다. 실제로 반영하려면 --apply 를 붙이세요.');
    needsTag.slice(0, 5).forEach((c) => console.log(`  ${c.email} → 태그 ${c.tags.length}개 + ${MEMBER_TAG}`));
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const c of needsTag) {
    const merged = Array.from(new Set([...c.tags, MEMBER_TAG]));
    const res = await gql(token, `
      mutation AddMemberTag($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
    `, { input: { id: c.id, tags: merged } });

    const userErrors = res?.data?.customerUpdate?.userErrors ?? [];
    if (res?.errors || userErrors.length > 0 || !res?.data?.customerUpdate?.customer?.id) {
      failed++;
      console.error(`  🔴 실패 ${c.email}: ${JSON.stringify(res?.errors ?? userErrors)}`);
    } else {
      ok++;
    }
  }
  console.log(`\n완료: 성공 ${ok}명 / 실패 ${failed}명`);
}

main().catch((err) => {
  console.error('🔴', err);
  process.exit(1);
});
