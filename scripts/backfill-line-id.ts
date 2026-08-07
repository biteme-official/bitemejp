/**
 * LINE ID 매핑 백필 (일회성)
 *
 * api/line-callback.ts 는 LINE 로그인 시 Shopify 고객에
 * `line_id:{userId}` 태그와 `custom.line_id` 메타필드를 저장하도록 되어 있으나,
 * REPORT 앱에 write_customers 스코프가 없어 전량 실패해 왔다 (Issue #102).
 *
 * 다행히 이메일 미동의 유저는 `line_{userId}@line-user.biteme.co.jp` 형태로
 * 고객이 생성되어 있어 로컬파트에서 LINE userId를 그대로 복구할 수 있다.
 * (이메일 동의 유저는 실제 이메일로 생성되어 userId가 남아있지 않다 → 재로그인 필요)
 *
 * 사용법:
 *   npx tsx scripts/backfill-line-id.ts          # 미리보기 (쓰기 없음)
 *   npx tsx scripts/backfill-line-id.ts --apply  # 실제 반영
 *
 * ⚠️ 선행 조건: REPORT 앱에 write_customers 스코프가 부여되어 있어야 한다.
 *    (Partner Dashboard 스코프 추가 → 새 app version 릴리스 → 스토어 재설치)
 *    스크립트가 시작 시 스코프를 검사하고, 없으면 즉시 중단한다.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env.production') });
config({ path: join(__dirname, '..', '.env') });

const STORE_DOMAIN = process.env.VITE_SHOPIFY_STORE_DOMAIN!;
const CLIENT_ID = process.env.REPORT_SHOPIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.REPORT_SHOPIFY_CLIENT_SECRET!;
const API_VERSION = '2025-07';

/** LINE 로그인 시 이메일 미동의 유저에게 부여되는 도메인 (api/line-callback.ts:102) */
const LINE_EMAIL_DOMAIN = '@line-user.biteme.co.jp';

const APPLY = process.argv.includes('--apply');

interface Customer {
  id: string;
  email: string | null;
  tags: string[];
  metafield: { value: string } | null;
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
  if (!res.ok) throw new Error(`토큰 발급 실패: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: unknown;
}

async function adminGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<GraphQLResponse<T>> {
  const res = await fetch(`https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

/** write_customers 스코프가 없으면 백필이 전량 실패하므로 선제 검사 */
async function assertWriteScope(token: string): Promise<void> {
  const res = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_scopes.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const scopes: string[] = ((await res.json()).access_scopes ?? []).map(
    (s: { handle: string }) => s.handle
  );

  if (!scopes.includes('write_customers')) {
    console.error('🔴 REPORT 앱에 write_customers 스코프가 없습니다. 백필을 실행해도 전량 실패합니다.\n');
    console.error(`   현재 스코프 (${scopes.length}개): ${scopes.join(' ')}\n`);
    console.error('   해결: Shopify Partner Dashboard 에서 write_customers 추가');
    console.error('         → 새 app version 릴리스 → 스토어 재설치(재동의)');
    console.error('         (관리형 앱이라 릴리스만으로는 grant 되지 않음)');
    process.exit(1);
  }
  console.log(`✅ write_customers 스코프 확인됨 (전체 ${scopes.length}개)\n`);
}

/** LINE userId 는 U + 32자리 hex */
function extractLineUserId(email: string): string | null {
  if (!email.endsWith(LINE_EMAIL_DOMAIN)) return null;
  const localPart = email.slice(0, -LINE_EMAIL_DOMAIN.length);
  if (!localPart.startsWith('line_')) return null;
  const userId = localPart.slice('line_'.length);
  return /^U[0-9a-f]{32}$/.test(userId) ? userId : null;
}

interface CustomersPage {
  customers: {
    pageInfo: { hasNextPage: boolean; endCursor: string };
    edges: { node: Customer }[];
  };
}

async function fetchAllCustomers(token: string): Promise<Customer[]> {
  const all: Customer[] = [];
  let cursor: string | null = null;

  while (true) {
    // 명시적 annotation 필수: cursor 가 응답에서 재할당되어 순환 추론(TS7022)이 발생함
    const data: GraphQLResponse<CustomersPage> = await adminGraphQL<CustomersPage>(
      token,
      `query($c: String) {
        customers(first: 250, after: $c) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id
            email
            tags
            metafield(namespace: "custom", key: "line_id") { value }
          } }
        }
      }`,
      { c: cursor }
    );

    const conn = data.data?.customers;
    if (!conn) throw new Error(`고객 조회 실패: ${JSON.stringify(data).slice(0, 300)}`);

    all.push(...conn.edges.map((e) => e.node));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return all;
}

async function saveLineId(token: string, customer: Customer, userId: string): Promise<void> {
  // 기존 태그 보존 (api/line-callback.ts:174 와 동일한 병합 규칙)
  const mergedTags = Array.from(
    new Set([...customer.tags.filter((t) => !t.startsWith('line_id:')), `line_id:${userId}`])
  );

  const result = await adminGraphQL<{
    customerUpdate: {
      customer: { id: string } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(
    token,
    `mutation SaveLineId($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: customer.id,
        tags: mergedTags,
        metafields: [
          {
            namespace: 'custom',
            key: 'line_id',
            value: userId,
            type: 'single_line_text_field',
          },
        ],
      },
    }
  );

  if (result.errors) throw new Error(`GraphQL: ${JSON.stringify(result.errors)}`);

  const userErrors = result.data?.customerUpdate?.userErrors ?? [];
  if (userErrors.length > 0) throw new Error(`userErrors: ${JSON.stringify(userErrors)}`);
}

async function main() {
  console.log(`\nLINE ID 매핑 백필 — ${APPLY ? '🔴 실제 반영 모드' : '미리보기 모드 (쓰기 없음)'}\n`);

  const token = await getAccessToken();
  if (APPLY) await assertWriteScope(token);

  console.log('고객 목록 조회 중...');
  const customers = await fetchAllCustomers(token);

  const targets = customers
    .map((c) => ({ customer: c, userId: c.email ? extractLineUserId(c.email) : null }))
    .filter((t): t is { customer: Customer; userId: string } => t.userId !== null);

  const alreadyDone = targets.filter((t) => t.customer.metafield?.value === t.userId);
  const todo = targets.filter((t) => t.customer.metafield?.value !== t.userId);

  console.log(`\n전체 고객            ${customers.length}명`);
  console.log(`LINE 로그인 계정      ${targets.length}명`);
  console.log(`  └ 이미 매핑됨       ${alreadyDone.length}명`);
  console.log(`  └ 백필 대상         ${todo.length}명\n`);

  if (todo.length === 0) {
    console.log('백필할 대상이 없습니다.');
    return;
  }

  if (!APPLY) {
    console.log('백필 대상 샘플 (최대 5건):');
    todo.slice(0, 5).forEach((t) => console.log(`  ${t.customer.email} → line_id:${t.userId}`));
    console.log('\n실제 반영하려면 --apply 를 붙여 다시 실행하세요.');
    return;
  }

  let ok = 0;
  const failures: string[] = [];

  for (const [i, t] of todo.entries()) {
    try {
      await saveLineId(token, t.customer, t.userId);
      ok++;
    } catch (err) {
      failures.push(`${t.customer.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${todo.length}`);
    // Admin API rate limit 여유 확보
    await new Promise((r) => setTimeout(r, 120));
  }

  console.log(`\n완료 — 성공 ${ok}건 / 실패 ${failures.length}건`);
  if (failures.length > 0) {
    console.log('\n실패 목록:');
    failures.forEach((f) => console.log(`  ${f}`));
  }
}

main().catch((err) => {
  console.error('\n🔴 백필 중단:', err);
  process.exit(1);
});
