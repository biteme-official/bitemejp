/**
 * /api/line-restock — 품절 상품 재입고 LINE 알림
 *
 * 한 파일에 두 갈래가 있다.
 *   - POST  신청. 상품 상세에서 품절 옵션을 보던 LINE 로그인 고객이 「再入荷をLINEで受け取る」를 누르면 온다.
 *   - POST  ?action=send  발송. 어드민 「재입고 알림」 탭에서 운영자가 고른 신청에게만 LINE 을 보낸다 (#227).
 *   - GET   ?view=admin   어드민 목록 · 그 밖의 GET 은 미리보기(dryRun)만 — 아무에게도 보내지 않는다.
 *
 * 🔴 자동 발송은 하지 않는다 (#227). 예전엔 크론이 매시 30분에 재고가 풀린 신청을 전부 보냈는데,
 *    재고 수정 실수·소량 입고에도 바로 나가 버려서 운영자가 골라 보내는 방식으로 바꿨다.
 *
 * 저장소는 따로 만들지 않고 Supabase `events` 를 그대로 쓴다(장바구니 스냅샷과 같은 방식).
 *   - 신청   event_type = `line_restock_sub` · session_id = `line:<userId>`
 *   - 발송   `line_send` (journey = `restock`, ref = 신청 행을 가리키는 키)
 * 신청 한 건에 알림은 한 통이다. 다시 품절됐다가 또 받고 싶으면 다시 신청하면 된다.
 *
 * 🔴 신청자의 LINE userId 는 클라이언트가 보낸 값을 믿지 않는다. 서명된 `lineSessionToken` 에서만
 *    꺼낸다 — 안 그러면 남의 userId 로 신청해 그 사람에게 메시지를 보내게 만들 수 있다.
 *
 * 마케팅 빈도 제한(하루 1통)은 걸지 않는다(`kind: transactional`). 고객이 직접 달라고 한 알림이라,
 * 그날 다른 저니가 먼저 나갔다고 재입고 소식이 사라지면 신청한 의미가 없다.
 * 조용한 시간(JST 21~09시)은 막지 않고 화면에서 경고만 한다 — 운영자가 직접 누르는 발송이라서.
 *
 * ⚠️ `LINE_RESTOCK_ENABLED=1` 일 때만 실제로 보낸다(꺼 두면 미리보기만 된다).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  SEND_EVENT,
  adminGraphQL,
  fetchQuota,
  getAdminToken,
  inQuietHours,
  lineToken,
  readAll,
  recordSends,
  supabase,
  type Db,
} from './line-campaign.js';

export const RESTOCK_SUB_EVENT = 'line_restock_sub';
/**
 * 발송 이력 (#322) — 「보내기」를 한 번 누를 때마다 시작·끝 두 행. 사람별 기록(`line_send`)과 따로 둔다.
 *   phase=start  누른 순간 · 몇 명에게 무엇을
 *   phase=done   끝난 뒤 · 보냄/친구 아님/실패
 * start 만 있고 done 이 없으면 함수가 도중에 끊긴 것 — 화면에 「중단됨」으로 보이고, 실제 나간 건 사람별 기록이 맞다.
 */
const BATCH_EVENT = 'line_restock_batch';
/** start 뒤 이 시간 안에 done 이 없으면 아직 보내는 중으로 보고 새 발송을 막는다(두 번 눌림·두 창) */
const BATCH_LOCK_MS = 3 * 60_000;
const JOURNEY = 'restock';
const UTM = 'line_restock';

/** 이보다 오래된 신청은 보지 않는다. 신청 행을 끝없이 다시 읽지 않기 위한 상한. */
const SUB_TTL_DAYS = 180;
/** 한 번 누를 때 보낼 수 있는 최대 인원 — 함수 시간 안에 끝나도록. 넘으면 나눠서 보낸다. */
const MAX_PER_RUN = 200;

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** api/line-callback.ts 의 signSessionToken 과 한 쌍 (api/line-cart.ts 와 같은 구현). api/line-launch.ts 도 쓴다 */
export function verifySessionToken(token: unknown, secret: string): { lineUserId: string } | null {
  if (typeof token !== 'string') return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.e !== 'number' || Date.now() > payload.e) return null;
    if (typeof payload?.u !== 'string' || !payload.u) return null;
    return { lineUserId: payload.u };
  } catch {
    return null;
  }
}

export function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

/** api/line-journey.ts 와 같은 규칙 — `x-vercel-cron` 헤더는 누구나 붙일 수 있어 인증으로 쓰지 않는다 */
function authorized(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (process.env.ADMIN_SECRET && auth === `Bearer ${process.env.ADMIN_SECRET}`) return true;
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  return false;
}

/** 발송·어드민 목록은 어드민만 — 크론 시크릿으로는 열지 않는다 */
export function adminOnly(req: VercelRequest): boolean {
  return !!process.env.ADMIN_SECRET && req.headers.authorization === `Bearer ${process.env.ADMIN_SECRET}`;
}

// ─── Shopify ─────────────────────────────────────────────────────────────────

interface VariantState {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  /** 지금 팔 수 있는가 — 상품이 판매 중(ACTIVE)이고 옵션이 구매 가능 */
  available: boolean;
  /** 판매 종료 태그가 붙은 옵션 — 다시 들어오지 않으니 신청을 받지 않는다 (#223) */
  discontinued: boolean;
}

/**
 * 판매 종료 태그 (#223). src/lib/productStock.ts 의 isVariantDiscontinued 와 같은 규칙 — 같이 고칠 것.
 *   `販売終了` 상품 전체 · `販売終了:<옵션명>` 그 옵션만 · `discontinued`·`단종` 도 같은 뜻
 */
const DISCONTINUED_TAGS = ['販売終了', 'discontinued', '단종'];
const normTitle = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function isVariantDiscontinued(tags: string[], variantTitle: string): boolean {
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    for (const key of DISCONTINUED_TAGS.map((k) => k.toLowerCase())) {
      if (t === key) return true;
      if (t.startsWith(`${key}:`) && normTitle(t.slice(key.length + 1)) === normTitle(variantTitle)) return true;
    }
  }
  return false;
}

interface VariantNodesResponse {
  data?: {
    nodes: ({
      id: string;
      title: string;
      availableForSale: boolean;
      product: { id: string; title: string; status: string; tags: string[] };
    } | null)[];
  };
  errors?: unknown;
}

/** 옵션 id 목록의 현재 상태. 없는(삭제된) 옵션은 결과에서 빠진다. */
async function fetchVariantStates(token: string, variantIds: string[]): Promise<Map<string, VariantState>> {
  const out = new Map<string, VariantState>();
  // nodes(ids:) 는 한 번에 250개까지 받는다
  for (let i = 0; i < variantIds.length; i += 250) {
    const ids = variantIds.slice(i, i + 250);
    const res = await adminGraphQL<VariantNodesResponse>(
      token,
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            availableForSale
            product { id title status tags }
          }
        }
      }`,
      { ids },
    );
    // 🔴 조회가 실패했는데 빈 결과로 넘기면 「아무것도 재입고 안 됨」으로 읽힌다. 실패는 실패로 던진다.
    if (!res?.data?.nodes) throw new Error(`옵션 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 200)}`);
    for (const n of res.data.nodes) {
      if (!n?.id || !n.product) continue;
      out.set(n.id, {
        variantId: n.id,
        productId: n.product.id,
        productTitle: n.product.title,
        // 옵션이 하나뿐인 상품은 Shopify 가 「Default Title」을 준다 — 문안에 쓰지 않는다
        variantTitle: n.title === 'Default Title' ? '' : n.title,
        available: n.product.status === 'ACTIVE' && n.availableForSale,
        discontinued: isVariantDiscontinued(n.product.tags ?? [], n.title),
      });
    }
  }
  return out;
}

// ─── LINE ────────────────────────────────────────────────────────────────────

/**
 * 공식계정 친구인가. push 는 친구에게만 닿으므로 신청 시점에 알려 준다.
 * 확인이 안 되면(토큰 없음·LINE 장애) null — 신청은 받고 안내만 생략한다.
 */
export async function isFriend(userId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${lineToken()}` },
    });
    if (res.ok) return true;
    // 404 = 친구가 아니거나 차단
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

export async function pushLine(userId: string, text: string): Promise<'sent' | 'not-friend' | 'failed'> {
  return (await pushLineDetailed(userId, text)).result;
}

/** LINE 오류를 운영자가 읽을 수 있는 말로 (#324) */
function lineFailReason(status: number, body: string): string {
  let msg = '';
  try {
    msg = String((JSON.parse(body) as { message?: string }).message ?? '');
  } catch {
    msg = body.slice(0, 120);
  }
  if (status === 429 && /monthly limit/i.test(msg)) return 'LINE 월 발송 한도 초과';
  if (status === 429) return 'LINE 요청이 너무 많음(잠시 뒤 다시)';
  if (status === 401) return 'LINE 토큰 오류(채널 토큰 만료·잘못됨)';
  if (status === 400) return `LINE 이 메시지를 거부함${msg ? ` — ${msg}` : ''}`;
  if (status >= 500) return `LINE 서버 오류 ${status}`;
  return `LINE 오류 ${status}${msg ? ` — ${msg}` : ''}`;
}

/** push 한 통 + 실패면 이유. 네트워크 오류도 실패로 돌려준다(던지면 그 뒤 사람들이 통째로 안 나간다) */
export async function pushLineDetailed(
  userId: string,
  text: string,
): Promise<{ result: 'sent' | 'not-friend' | 'failed'; reason?: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken()}` },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
    });
  } catch (e) {
    const reason = `LINE 연결 실패 — ${e instanceof Error ? e.message : '네트워크 오류'}`;
    console.error(`[LINE Restock] 🔴 push 실패: ${reason}`);
    return { result: 'failed', reason };
  }
  if (res.ok) return { result: 'sent' };
  // 403 = 친구가 아니거나 차단. 우리가 고칠 수 있는 게 아니다.
  if (res.status === 403) return { result: 'not-friend' };
  const body = await res.text();
  console.error(`[LINE Restock] 🔴 push 실패 ${res.status}: ${body.slice(0, 200)}`);
  return { result: 'failed', reason: lineFailReason(res.status, body) };
}

// ─── 신청 기록 ────────────────────────────────────────────────────────────────

interface Subscription {
  lineUserId: string;
  productId: string;
  variantId: string;
  createdAt: string;
  /** 발송 기록의 ref — 이 신청을 가리키는 키. 같은 사람·옵션이라도 다시 신청하면 새 키가 된다. */
  ref: string;
}

function subRef(variantId: string, createdAt: string): string {
  return `${variantId.split('/').pop()}@${createdAt}`;
}

// readAll·Db 는 line-campaign.ts 로 옮겼다(그쪽 성과·빈도 제한 조회도 같은 함수를 쓴다).
// line-launch 등 기존 import 경로를 깨지 않으려고 여기서 다시 내보낸다.
export { readAll };
export type { Db };

interface RestockSendRow {
  session_id: string;
  created_at: string;
  properties: { journey?: string; ref?: string; delivery?: string } | null;
}

/**
 * 재입고 알림 발송 기록만 읽는다 (#322).
 *
 * 🔴 예전엔 `line_send` 전체(캠페인·저니 전부, 180일)를 다 읽고 여기서 journey 로 걸렀다.
 *    캠페인 한 번에 수천 행이라 수십 번 나눠 읽느라 발송·목록 요청이 느려지고, readAll 상한(10만 행)을
 *    넘으면 오래된 것부터 읽으니 **최근 재입고 발송 기록이 잘려 「안 보냄」으로 보였다** — 다시 보낼 수 있게 됐다.
 *    DB 에서 journey 로 거르면 재입고 몇 건만 온다.
 */
async function readRestockSends(db: Db, since: string): Promise<RestockSendRow[]> {
  const out: RestockSendRow[] = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await db
      .from('events')
      .select('session_id, created_at, properties')
      .eq('event_type', SEND_EVENT)
      .eq('properties->>journey', JOURNEY)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    // 🔴 발송 기록을 못 읽었는데 빈 목록으로 넘기면 전부 「안 보냄」이 돼 다시 나간다. 실패는 실패로 던진다.
    if (error) throw new Error(`재입고 발송 기록 조회 실패: ${error.message}`);
    out.push(...((data ?? []) as RestockSendRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** 아직 알림이 나가지 않은 신청 */
async function pendingSubscriptions(db: Db, now: number): Promise<Subscription[]> {
  const since = new Date(now - SUB_TTL_DAYS * 86_400_000).toISOString();
  const [subs, sends] = await Promise.all([
    readAll<{ session_id: string; created_at: string; properties: { productId?: string; variantId?: string } | null }>(
      db, RESTOCK_SUB_EVENT, 'session_id, created_at, properties', since,
    ),
    readRestockSends(db, since),
  ]);

  // 같은 신청(ref)이라도 사람이 다르면 다른 신청이다 — 키에 사람을 넣는다
  const done = new Set<string>();
  for (const s of sends) {
    if (s.properties?.ref) done.add(`${s.session_id}|${s.properties.ref}`);
  }

  // 같은 사람이 같은 옵션을 여러 번 눌렀으면 한 건으로 친다 — 가장 최근 신청만 남긴다
  const latest = new Map<string, Subscription>();
  for (const row of subs) {
    const { productId, variantId } = row.properties ?? {};
    if (!row.session_id.startsWith('line:') || !productId || !variantId) continue;
    const lineUserId = row.session_id.slice(5);
    latest.set(`${lineUserId}|${variantId}`, {
      lineUserId,
      productId,
      variantId,
      createdAt: row.created_at,
      ref: subRef(variantId, row.created_at),
    });
  }
  return [...latest.values()].filter((s) => !done.has(`line:${s.lineUserId}|${s.ref}`));
}

// ─── 지금 품절 목록 (#225) ─────────────────────────────────────────────────────

/** 한글 상품명을 직접 적어 두는 Shopify 상품 메타필드. 있으면 AI 번역보다 우선 */
const NAME_KO_NAMESPACE = 'custom';
const NAME_KO_KEY = 'name_ko';
/** AI 로 번역한 한글명 저장(events). 같은 일본어 상품명이면 다시 번역하지 않는다 */
const NAME_KO_EVENT = 'product_name_ko';
const TRANSLATE_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';

export interface SoldOutProduct {
  productId: string;
  title: string;
  /** 한글 상품명. 메타필드도 번역도 없으면 null */
  titleKo: string | null;
  titleKoSource: 'shopify' | 'ai' | null;
  /** 옵션 전체 개수 — 「3개 중 2개 품절」 */
  variantCount: number;
  /** 품절 옵션. discontinued = 판매 종료 태그(목록에서 숨고 알림 안 받음) */
  soldOut: { id: string; title: string; discontinued: boolean }[];
}

interface ProductVariantsPage {
  data?: {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        id: string;
        title: string;
        availableForSale: boolean;
        product: {
          id: string;
          title: string;
          status: string;
          tags: string[];
          nameKo: { value: string } | null;
        };
      }[];
    };
  };
  errors?: unknown;
}

/** 판매 중(ACTIVE) 상품 중 품절 옵션이 있는 것. 옵션 단위로 훑어 상품별로 묶는다 */
async function fetchSoldOutProducts(token: string): Promise<SoldOutProduct[]> {
  const byProduct = new Map<string, SoldOutProduct & { nameKo: string | null }>();
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const res: ProductVariantsPage | null = await adminGraphQL<ProductVariantsPage>(
      token,
      `query($after: String) {
        productVariants(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            availableForSale
            product {
              id title status tags
              nameKo: metafield(namespace: "${NAME_KO_NAMESPACE}", key: "${NAME_KO_KEY}") { value }
            }
          }
        }
      }`,
      { after },
    );
    const conn: NonNullable<ProductVariantsPage['data']>['productVariants'] | undefined = res?.data?.productVariants;
    if (!conn) throw new Error(`품절 목록 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 200)}`);
    for (const v of conn.nodes) {
      if (v.product.status !== 'ACTIVE') continue;
      const cur: SoldOutProduct & { nameKo: string | null } = byProduct.get(v.product.id) ?? {
        productId: v.product.id,
        title: v.product.title,
        titleKo: null,
        titleKoSource: null,
        nameKo: v.product.nameKo?.value?.trim() || null,
        variantCount: 0,
        soldOut: [],
      };
      cur.variantCount++;
      if (!v.availableForSale) {
        cur.soldOut.push({
          id: v.id,
          title: v.title === 'Default Title' ? '' : v.title,
          discontinued: isVariantDiscontinued(v.product.tags ?? [], v.title),
        });
      }
      byProduct.set(v.product.id, cur);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return [...byProduct.values()]
    .filter((p) => p.soldOut.length > 0)
    .map(({ nameKo, ...p }) => (nameKo ? { ...p, titleKo: nameKo, titleKoSource: 'shopify' as const } : p));
}

/** 일본어 상품명 → 한글. 실패하면 빈 Map(목록은 일본어만으로 보여 준다) */
async function translateTitles(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const key = process.env.GEMINI_API_KEY;
  if (!key || titles.length === 0) return out;
  const prompt = `次の日本語の商品名(韓国のペット用品ブランド BITE ME の商品)を、韓国のオンラインストアで使う自然な韓国語の商品名に訳してください。
- ブランド名・シリーズ名は韓国語の表記(例: BITE ME → 바잇미)
- 説明を足さず、商品名だけ
- 入力と同じ順番・同じ件数の配列で返す

${JSON.stringify(titles)}`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TRANSLATE_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
          temperature: 0.2,
        },
      }),
    });
    const json = (await res.json()) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${json.error?.message ?? 'unknown'}`);
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const arr = JSON.parse(text) as unknown;
    // 순서가 어긋나면 엉뚱한 이름이 붙는다 — 개수가 다르면 통째로 버린다
    if (!Array.isArray(arr) || arr.length !== titles.length) throw new Error('번역 개수가 맞지 않음');
    titles.forEach((t, i) => {
      const ko = typeof arr[i] === 'string' ? oneLine(arr[i] as string).slice(0, 200) : '';
      if (ko) out.set(t, ko);
    });
  } catch (e) {
    console.error('[LINE Restock] 한글 상품명 번역 실패:', e instanceof Error ? e.message : e);
  }
  return out;
}

interface ProductNodesResponse {
  data?: { nodes: ({ id: string; title: string; nameKo: { value: string } | null } | null)[] };
  errors?: unknown;
}

/** 상품 id 목록의 현재 일본어명 + 한글명 메타필드. 없는(삭제된) 상품은 빠진다 */
async function fetchProductNames(
  token: string,
  productIds: string[],
): Promise<{ productId: string; title: string; titleKo: string | null; titleKoSource: 'shopify' | 'ai' | null }[]> {
  const out: { productId: string; title: string; titleKo: string | null; titleKoSource: 'shopify' | 'ai' | null }[] = [];
  for (let i = 0; i < productIds.length; i += 250) {
    const res = await adminGraphQL<ProductNodesResponse>(
      token,
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            nameKo: metafield(namespace: "${NAME_KO_NAMESPACE}", key: "${NAME_KO_KEY}") { value }
          }
        }
      }`,
      { ids: productIds.slice(i, i + 250) },
    );
    if (!res?.data?.nodes) throw new Error(`상품명 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 200)}`);
    for (const n of res.data.nodes) {
      if (!n?.id || !n.title) continue;
      const ko = n.nameKo?.value?.trim() || null;
      out.push({ productId: n.id, title: n.title, titleKo: ko, titleKoSource: ko ? 'shopify' : null });
    }
  }
  return out;
}

/** 메타필드가 없는 상품에 AI 한글명을 붙인다. 번역은 저장해 두고 다음부터 재사용 */
async function attachKoreanTitles(
  db: Db,
  products: { title: string; titleKo: string | null; titleKoSource: 'shopify' | 'ai' | null }[],
): Promise<void> {
  const need = products.filter((p) => !p.titleKo);
  if (need.length === 0) return;
  const cached = await readAll<{ properties: { title?: string; ko?: string } | null }>(
    db, NAME_KO_EVENT, 'properties', '2026-01-01T00:00:00Z',
  ).catch(() => []);
  const known = new Map<string, string>();
  for (const r of cached) if (r.properties?.title && r.properties.ko) known.set(r.properties.title, r.properties.ko);

  const missing = [...new Set(need.map((p) => p.title).filter((t) => !known.has(t)))];
  // 한 번에 너무 많이 보내면 순서가 흐트러지기 쉽다 — 50개씩
  for (let i = 0; i < missing.length; i += 50) {
    const got = await translateTitles(missing.slice(i, i + 50));
    if (got.size === 0) continue;
    for (const [t, ko] of got) known.set(t, ko);
    const { error } = await db.from('events').insert(
      [...got].map(([title, ko]) => ({
        event_type: NAME_KO_EVENT,
        session_id: 'system',
        properties: { title, ko, model: TRANSLATE_MODEL },
        page_path: '/admin',
        referrer: null,
      })),
    );
    if (error) console.error('[LINE Restock] 한글 상품명 저장 실패:', error.message);
  }
  for (const p of need) {
    const ko = known.get(p.title);
    if (ko) {
      p.titleKo = ko;
      p.titleKoSource = 'ai';
    }
  }
}

// ─── GET ?view=admin: 어드민 「재입고 알림」 탭 ─────────────────────────────────

export type RestockStatus = 'waiting' | 'ready' | 'sent' | 'not_friend' | 'gone' | 'discontinued';

export interface RestockAdminRow {
  /** 이 신청의 키 — 화면에서 골라 보낼 때 이 값을 돌려준다 */
  ref: string;
  createdAt: string;
  /** LINE 표시 이름. 친구가 아니면 알 수 없어 null */
  displayName: string | null;
  /** 끝 6자리만 — 화면에 userId 전체를 띄우지 않는다 */
  userTail: string;
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  /**
   * waiting    아직 품절
   * ready      다시 팔리는 중 — 화면에서 골라 보내면 나간다
   * sent       알림 보냄
   * not_friend 보냈지만 친구가 아니라 닿지 않음
   * gone       옵션이 삭제됨
   * discontinued 품절인 채로 판매 종료 태그가 붙음 — 알림이 나갈 일 없음 (#223)
   */
  status: RestockStatus;
  sentAt: string | null;
}

export async function lineDisplayName(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${lineToken()}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { displayName?: string }).displayName ?? null;
  } catch {
    return null;
  }
}

// ─── 속도 (#328) ──────────────────────────────────────────────────────────────
// 함수가 따뜻한 동안(같은 인스턴스가 다음 요청을 받는 동안)만 쓰는 기억. 식으면 다시 받는다.

/** Shopify Admin 토큰 — 매번 새로 받으면 요청마다 OAuth 왕복이 붙는다. client_credentials 토큰은 하루 가므로 30분만 쓴다 */
let tokenMemo: { token: string; at: number } | null = null;
const TOKEN_TTL_MS = 30 * 60_000;

async function cachedAdminToken(): Promise<string> {
  if (tokenMemo && Date.now() - tokenMemo.at < TOKEN_TTL_MS) return tokenMemo.token;
  const token = await getAdminToken();
  tokenMemo = { token, at: Date.now() };
  return token;
}

/** LINE 표시 이름 — 사람마다 LINE 에 한 번씩 물어야 해서 신청이 많으면 오래 걸린다. 6시간 기억 */
const nameMemo = new Map<string, { name: string | null; at: number }>();
const NAME_TTL_MS = 6 * 3600_000;
const NAME_CONCURRENCY = 25;

async function displayNames(userIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const now = Date.now();
  const todo: string[] = [];
  for (const u of userIds) {
    const m = nameMemo.get(u);
    if (m && now - m.at < NAME_TTL_MS) out.set(u, m.name);
    else todo.push(u);
  }
  // 한 줄로 세워 NAME_CONCURRENCY 개씩 동시에 — 묶음 단위로 기다리지 않고 하나 끝나면 다음
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const u = todo[next++];
      const name = await lineDisplayName(u);
      out.set(u, name);
      nameMemo.set(u, { name, at: Date.now() });
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, todo.length) }, worker));
  return out;
}

/** GET ?view=soldout — 「지금 품절 목록」. 쇼핑몰 옵션 전부를 훑어서 오래 걸리므로 탭 목록과 따로 받는다 (#328) */
async function soldOutList(req: VercelRequest, res: VercelResponse) {
  if (!adminOnly(req)) return res.status(401).json({ error: 'Unauthorized' });
  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });
  const t = Date.now();
  try {
    const soldOut = await fetchSoldOutProducts(await cachedAdminToken());
    await attachKoreanTitles(db, soldOut);
    console.log(`[LINE Restock] 품절 목록 ${Date.now() - t}ms · 상품 ${soldOut.length}`);
    return res.status(200).json({ soldOut, soldOutError: null });
  } catch (e) {
    return res.status(200).json({ soldOut: [], soldOutError: e instanceof Error ? e.message : '품절 목록 조회 실패' });
  }
}

async function adminList(req: VercelRequest, res: VercelResponse) {
  if (!adminOnly(req)) return res.status(401).json({ error: 'Unauthorized' });
  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });

  const now = Date.now();
  const since = new Date(now - SUB_TTL_DAYS * 86_400_000).toISOString();
  const [subs, sends] = await Promise.all([
    readAll<{
      session_id: string;
      created_at: string;
      properties: { productId?: string; variantId?: string; productTitle?: string; variantTitle?: string } | null;
    }>(db, RESTOCK_SUB_EVENT, 'session_id, created_at, properties', since),
    readRestockSends(db, since),
  ]);

  // 키 = 사람|신청 — pendingSubscriptions 와 같은 규칙
  const sentByRef = new Map<string, { at: string; delivery: string }>();
  for (const s of sends) {
    if (s.properties?.ref) {
      sentByRef.set(`${s.session_id}|${s.properties.ref}`, { at: s.created_at, delivery: s.properties.delivery ?? 'sent' });
    }
  }
  const sentOf = (r: { session_id: string; created_at: string; properties: { variantId?: string } | null }) =>
    sentByRef.get(`${r.session_id}|${subRef(r.properties!.variantId!, r.created_at)}`);

  // 같은 사람·옵션을 여러 번 누른 건 한 줄 — 발송 쪽과 같은 규칙(가장 최근 신청)
  const latest = new Map<string, (typeof subs)[number]>();
  for (const row of subs) {
    const p = row.properties ?? {};
    if (!row.session_id.startsWith('line:') || !p.productId || !p.variantId) continue;
    latest.set(`${row.session_id}|${p.variantId}`, row);
  }
  const rows = [...latest.values()];

  const tRead = Date.now() - now;

  // 🔴 속도 (#328): 아래 셋은 서로를 기다릴 필요가 없다 — 예전엔 재고 → 고객 이름 → 품절 목록 → 상품명을
  //    차례로 하느라 탭이 뜨는 데 오래 걸렸다. 동시에 돌리고, 「지금 품절 목록」은 ?view=soldout 으로 따로 받는다.
  const unsent = rows.filter((r) => !sentOf(r));
  const productIds = [...new Set(rows.map((r) => r.properties!.productId!))].slice(0, 250);
  const userIds = [...new Set(rows.map((r) => r.session_id.slice(5)))].slice(0, 300);
  const timing: Record<string, number> = {};
  const timed = async <T,>(label: string, p: Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await p;
    } finally {
      timing[label] = Date.now() - t;
    }
  };

  const [states, names, namesKo, batches] = await Promise.all([
    // 아직 안 보낸 신청만 지금 재고를 본다
    timed(
      'stock',
      unsent.length
        ? cachedAdminToken().then((t) => fetchVariantStates(t, [...new Set(unsent.map((r) => r.properties!.variantId!))]))
        : Promise.resolve(new Map<string, VariantState>()),
    ),
    // 이름은 사람마다 한 번만 묻는다(친구가 아니면 null) — 한동안 기억해 둔다
    timed('names', displayNames(userIds)),
    // 신청 상품의 한글명 (#258). 실패해도 목록은 일본어만으로 보여 준다
    timed(
      'namesKo',
      (async () => {
        const out: Record<string, { ko: string; source: 'shopify' | 'ai' }> = {};
        try {
          if (productIds.length) {
            const named = await fetchProductNames(await cachedAdminToken(), productIds);
            await attachKoreanTitles(db, named);
            for (const p of named) if (p.titleKo && p.titleKoSource) out[p.productId] = { ko: p.titleKo, source: p.titleKoSource };
          }
        } catch (e) {
          console.error('[LINE Restock] 신청 상품 한글명 실패:', e instanceof Error ? e.message : e);
        }
        return out;
      })(),
    ),
    // 발송 이력 — 실패해도 나머지 목록은 보여 준다
    timed(
      'batches',
      readBatches(db, since, now).catch((e) => {
        console.error('[LINE Restock] 발송 이력 조회 실패:', e instanceof Error ? e.message : e);
        return [] as RestockBatch[];
      }),
    ),
  ]);

  const out: RestockAdminRow[] = rows
    .map((r) => {
      const p = r.properties!;
      const userId = r.session_id.slice(5);
      const sent = sentOf(r);
      const state = states.get(p.variantId!);
      const status: RestockStatus = sent
        ? sent.delivery === 'not-friend' ? 'not_friend' : 'sent'
        : !state ? 'gone' : state.available ? 'ready' : state.discontinued ? 'discontinued' : 'waiting';
      return {
        ref: subRef(p.variantId!, r.created_at),
        createdAt: r.created_at,
        displayName: names.get(userId) ?? null,
        userTail: userId.slice(-6),
        productId: p.productId!,
        variantId: p.variantId!,
        productTitle: state?.productTitle ?? p.productTitle ?? '',
        variantTitle: state?.variantTitle ?? p.variantTitle ?? '',
        status,
        sentAt: sent?.at ?? null,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // 실행 기록에 어디서 오래 걸렸는지 남긴다
  console.log(
    `[LINE Restock] 목록 ${Date.now() - now}ms · 신청·발송 읽기 ${tRead} · ` +
      Object.entries(timing).map(([k, v]) => `${k} ${v}`).join(' · ') +
      ` · 신청 ${rows.length} · 사람 ${userIds.length}`,
  );

  return res.status(200).json({
    rows: out,
    batches,
    namesKo,
    enabled: process.env.LINE_RESTOCK_ENABLED === '1',
    quietHours: inQuietHours(new Date(now)),
    maxPerSend: MAX_PER_RUN,
    ttlDays: SUB_TTL_DAYS,
  });
}

// ─── 문안 ────────────────────────────────────────────────────────────────────

function productUrl(productId: string): string {
  const id = productId.split('/').pop();
  return `https://biteme.co.jp/product/${id}?utm_source=line&utm_medium=line&utm_campaign=${UTM}`;
}

/** 줄바꿈·제어문자를 지운다. 상품명에 섞여 들어오면 문안 줄이 어긋난다. */
export function oneLine(v: string): string {
  return [...v].map((ch) => (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! === 0x7f ? ' ' : ch)).join('').trim();
}

export function buildRestockMessage(items: { productId: string; productTitle: string; variantTitle: string }[]): string {
  const label = (i: (typeof items)[number]) =>
    `「${oneLine(i.productTitle)}${i.variantTitle ? `（${oneLine(i.variantTitle)}）` : ''}」`;

  const lines = ['お待たせしました🐾', 'BITE ME JAPANです。', ''];
  if (items.length === 1) {
    lines.push(`ご登録いただいた${label(items[0])}が再入荷しました。`);
  } else {
    lines.push('ご登録いただいた商品が再入荷しました。');
    for (const i of items) lines.push(`・${label(i)}`);
  }
  lines.push('', '数に限りがございますので、', 'お早めにご確認ください。', '');
  // 상품이 여럿이어도 링크는 상품마다 하나씩 — 옵션은 같은 상품 페이지에서 고른다
  const products = [...new Map(items.map((i) => [i.productId, i])).values()];
  for (const p of products) {
    lines.push(products.length === 1 ? '▼ 商品を見る' : `▼ ${oneLine(p.productTitle)}`, productUrl(p.productId));
  }
  return lines.join('\n');
}

/** 대시보드용 문구 — 실제 발송 함수로 만든다. 상품 자리만 자리표시자다(line-journey.ts 의 journeyCopy 와 같은 규칙) */
export function restockCopy(): { label: string | null; text: string }[] {
  return [{ label: null, text: buildRestockMessage([{ productId: '〔상품ID〕', productTitle: '〔상품명〕', variantTitle: '' }]) }];
}

// ─── POST: 신청 ──────────────────────────────────────────────────────────────

async function subscribe(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).json({ error: 'LINE_CHANNEL_SECRET 미설정' });

  let payload: unknown = req.body ?? {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: 'bad_request' });
    }
  }
  const { lineSessionToken, productId, variantId } = (payload ?? {}) as Record<string, unknown>;

  const session = verifySessionToken(lineSessionToken, secret);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  if (typeof productId !== 'string' || !PRODUCT_GID.test(productId)) return res.status(400).json({ error: 'bad_request' });
  if (typeof variantId !== 'string' || !VARIANT_GID.test(variantId)) return res.status(400).json({ error: 'bad_request' });

  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });

  // 옵션이 진짜 그 상품의 것이고 지금 품절인지 확인한다. 지어낸 id 로 신청 행이 쌓이지 않게.
  const states = await fetchVariantStates(await cachedAdminToken(), [variantId]);
  const state = states.get(variantId);
  if (!state || state.productId !== productId) return res.status(404).json({ error: 'not_found' });
  if (state.available) return res.status(409).json({ error: 'in_stock' });
  if (state.discontinued) return res.status(409).json({ error: 'discontinued' });

  // 이미 신청해 두고 아직 알림을 못 받은 상태면 행을 또 쌓지 않는다
  const pending = await pendingSubscriptions(db, Date.now());
  const already = pending.some((s) => s.lineUserId === session.lineUserId && s.variantId === variantId);

  if (!already) {
    const { error } = await db.from('events').insert({
      event_type: RESTOCK_SUB_EVENT,
      session_id: `line:${session.lineUserId}`,
      properties: {
        productId,
        variantId,
        productTitle: state.productTitle,
        variantTitle: state.variantTitle,
      },
      page_path: `/product/${productId.split('/').pop()}`,
      referrer: null,
    });
    if (error) {
      console.error('[LINE Restock] 신청 저장 실패:', error.message);
      return res.status(500).json({ error: 'failed' });
    }
  }

  const friend = await isFriend(session.lineUserId);
  return res.status(200).json({ ok: true, already, friend });
}

// ─── 발송 (어드민 수동, #227) ──────────────────────────────────────────────────

interface SendPlan {
  pending: number;
  /** 고른 신청 중 이미 보냈거나 목록에 없는 것 */
  notPending: number;
  /** 고른 신청 중 옵션이 삭제된 것 */
  missing: number;
  /** 고른 신청 중 지금 다시 품절인 것 — 보내지 않는다 */
  notAvailable: number;
  ready: number;
  targets: { userId: string; subs: Subscription[]; text: string }[];
  /** variantId → 지금 상품명 — 발송 이력에 남긴다 */
  titles: Map<string, string>;
}

/**
 * 보낼 대상. refs 가 있으면 그 신청만, 없으면 재고가 풀린 신청 전부(미리보기용).
 * 🔴 화면이 「재입고됨」이라고 보여 준 뒤 그새 다시 품절될 수 있다 — 고른 신청이라도 지금 재고를 다시 본다.
 */
async function planSend(db: Db, now: number, refs: Set<string> | null): Promise<SendPlan> {
  const all = await pendingSubscriptions(db, now);
  const pending = refs ? all.filter((s) => refs.has(s.ref)) : all;
  const states = pending.length
    ? await fetchVariantStates(await cachedAdminToken(), [...new Set(pending.map((s) => s.variantId))])
    : new Map<string, VariantState>();

  const ready = pending.filter((s) => states.get(s.variantId)?.available);

  // 한 사람에게 한 통 — 고른 옵션이 여러 개면 한 메시지에 묶는다
  const byUser = new Map<string, Subscription[]>();
  for (const s of ready) byUser.set(s.lineUserId, [...(byUser.get(s.lineUserId) ?? []), s]);
  const targets = [...byUser.entries()].map(([userId, subs]) => ({
    userId,
    subs,
    text: buildRestockMessage(subs.map((s) => states.get(s.variantId)!)),
  }));

  return {
    pending: pending.length,
    notPending: refs ? refs.size - pending.length : 0,
    missing: pending.filter((s) => !states.has(s.variantId)).length,
    notAvailable: pending.filter((s) => states.has(s.variantId) && !states.get(s.variantId)!.available).length,
    ready: ready.length,
    targets,
    titles: new Map([...states].map(([id, s]) => [id, s.productTitle])),
  };
}

// ─── 발송 이력 (#322) ─────────────────────────────────────────────────────────

export interface RestockBatch {
  batchId: string;
  startedAt: string;
  finishedAt: string | null;
  /** done = 끝까지 감 · sending = 아직 보내는 중 · aborted = 끝 기록 없이 끊김 */
  state: 'done' | 'sending' | 'aborted';
  /** 보내려던 사람 수 */
  willSend: number;
  /** 상품별 신청 수 — 「어떤 상품 알림이었나」 */
  products: { productId: string; title: string; n: number }[];
  sent: number | null;
  notFriend: number | null;
  failed: number | null;
  /** 고른 것 중 제외된 것 — 다시 품절·이미 보냄·옵션 삭제 */
  skipped: { notAvailable: number; notPending: number; missing: number };
  /** 실패 이유별 인원 (#324) */
  failReasons: Record<string, number>;
}

interface BatchRow {
  created_at: string;
  properties: {
    batchId?: string;
    phase?: 'start' | 'done';
    willSend?: number;
    products?: RestockBatch['products'];
    sent?: number;
    notFriend?: number;
    failed?: number;
    skipped?: RestockBatch['skipped'];
    failReasons?: Record<string, number>;
  } | null;
}

async function readBatches(db: Db, since: string, now: number): Promise<RestockBatch[]> {
  const rows = await readAll<BatchRow>(db, BATCH_EVENT, 'created_at, properties', since);
  const byId = new Map<string, RestockBatch>();
  for (const r of rows) {
    const p = r.properties;
    if (!p?.batchId) continue;
    const cur: RestockBatch = byId.get(p.batchId) ?? {
      batchId: p.batchId,
      startedAt: r.created_at,
      finishedAt: null,
      state: 'sending',
      willSend: 0,
      products: [],
      sent: null,
      notFriend: null,
      failed: null,
      skipped: { notAvailable: 0, notPending: 0, missing: 0 },
      failReasons: {},
    };
    if (p.phase === 'start') {
      cur.startedAt = r.created_at;
      cur.willSend = p.willSend ?? 0;
      cur.products = p.products ?? [];
      if (p.skipped) cur.skipped = p.skipped;
    } else if (p.phase === 'done') {
      cur.finishedAt = r.created_at;
      cur.state = 'done';
      cur.sent = p.sent ?? 0;
      cur.notFriend = p.notFriend ?? 0;
      cur.failed = p.failed ?? 0;
      cur.failReasons = p.failReasons ?? {};
    }
    byId.set(p.batchId, cur);
  }
  for (const b of byId.values()) {
    if (b.state === 'sending' && now - Date.parse(b.startedAt) > BATCH_LOCK_MS) b.state = 'aborted';
  }
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function writeBatch(db: Db, batchId: string, props: Record<string, unknown>): Promise<boolean> {
  const { error } = await db.from('events').insert({
    event_type: BATCH_EVENT,
    session_id: 'system',
    properties: { batchId, ...props },
    page_path: '/admin',
    referrer: null,
  });
  if (error) console.error('[LINE Restock] 🔴 발송 이력 저장 실패:', error.message);
  return !error;
}

/** GET — 미리보기만. 지금 재고가 풀린 신청 전부에게 무엇이 나갈지 (예전 크론 dryRun 과 같은 모양) */
async function preview(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });
  try {
    const plan = await planSend(db, Date.now(), null);
    return res.status(200).json({
      ok: true,
      dryRun: true,
      manualOnly: true,
      enabled: process.env.LINE_RESTOCK_ENABLED === '1',
      pending: plan.pending,
      missing: plan.missing,
      ready: plan.ready,
      willSend: plan.targets.length,
      samples: plan.targets.slice(0, 2).map((t) => t.text),
    });
  } catch (error) {
    console.error('[LINE Restock] 미리보기 오류:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : '미리보기 실패' });
  }
}

/**
 * POST ?action=send — 어드민이 고른 신청에게 보낸다.
 *   body { refs: string[], dryRun?: boolean }
 *   dryRun 이면 보내지 않고 몇 명에게 어떤 문안이 나가는지만 돌려준다(화면의 확인 단계).
 */
async function sendSelected(req: VercelRequest, res: VercelResponse) {
  if (!adminOnly(req)) return res.status(401).json({ error: 'Unauthorized' });
  const t0 = Date.now();

  let payload: unknown = req.body ?? {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: 'bad_request' });
    }
  }
  const { refs, dryRun } = (payload ?? {}) as Record<string, unknown>;
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((r) => typeof r === 'string' && r.length < 200)) {
    return res.status(400).json({ error: '보낼 신청을 골라 주세요' });
  }
  const selected = new Set(refs as string[]);
  const isDry = dryRun === true;
  const enabled = process.env.LINE_RESTOCK_ENABLED === '1';
  if (!isDry && !enabled) return res.status(409).json({ error: 'LINE_RESTOCK_ENABLED 가 꺼져 있어 보낼 수 없습니다' });

  // 🔴 중복 방지가 발송 기록 위에 선다. 기록이 없으면 같은 사람에게 몇 번이고 나간다.
  const db = supabase();
  if (!db) return res.status(500).json({ error: '발송 기록 저장소가 없어 중단했습니다' });

  try {
    const plan = await planSend(db, Date.now(), selected);
    const result = {
      ok: true,
      dryRun: isDry,
      enabled,
      quietHours: inQuietHours(new Date()),
      selected: selected.size,
      notPending: plan.notPending,
      missing: plan.missing,
      notAvailable: plan.notAvailable,
      ready: plan.ready,
      willSend: plan.targets.length,
      sent: 0,
      notFriend: 0,
      failed: 0,
      samples: plan.targets.slice(0, 2).map((t) => t.text),
    };
    if (plan.targets.length > MAX_PER_RUN) {
      return res.status(400).json({ ...result, ok: false, error: `한 번에 ${MAX_PER_RUN}명까지 보낼 수 있습니다 — 나눠서 골라 주세요` });
    }
    if (isDry || plan.targets.length === 0) {
      // 미리보기도 남긴다 (#326) — 「눌렀는데 안 나갔다」일 때 어디서 멈췄는지 실행 기록으로 보이게
      console.log(
        `[LINE Restock] ${isDry ? '미리보기' : '발송(대상 없음)'} ${Date.now() - t0}ms · 고른 ${selected.size} · 보낼 ${plan.targets.length}명 · 다시 품절 ${plan.notAvailable} · 이미 발송·없음 ${plan.notPending} · 옵션 삭제 ${plan.missing}`,
      );
      return res.status(200).json(result);
    }

    // LINE 월 발송 한도. 모자라면 아예 보내지 않는다 — 일부만 보내면
    // 한도가 바닥난 뒤의 주문·배송 알림까지 같이 막힌다(2026-09-24 한도 소진 때 실제로 그랬다).
    const quota = await fetchQuota().catch(() => null);
    if (quota && quota.remaining !== null && quota.remaining < plan.targets.length) {
      console.error(`[LINE Restock] 🔴 월 한도 부족 — 남은 ${quota.remaining}통 < 보낼 ${plan.targets.length}명. 보류합니다`);
      return res.status(409).json({ ...result, ok: false, error: `LINE 월 발송 한도 부족 — 남은 ${quota.remaining}통` });
    }

    // 다른 발송이 아직 끝나지 않았으면 막는다 — 두 번 누르거나 창 두 개에서 누르면 같은 사람에게 두 통 나갈 수 있다
    const now = Date.now();
    const recent = await readBatches(db, new Date(now - BATCH_LOCK_MS).toISOString(), now);
    if (recent.some((b) => b.state === 'sending')) {
      return res.status(409).json({ ...result, ok: false, error: '다른 재입고 알림을 보내는 중입니다 — 잠시 뒤 새로고침해 결과를 확인해 주세요' });
    }

    const batchId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const productCount = new Map<string, { productId: string; title: string; n: number }>();
    for (const t of plan.targets) {
      for (const s of t.subs) {
        const title = plan.titles.get(s.variantId) ?? '';
        const cur = productCount.get(s.productId) ?? { productId: s.productId, title, n: 0 };
        cur.n++;
        productCount.set(s.productId, cur);
      }
    }
    // 🔴 이력을 못 남기면 보내지 않는다 — 결과를 확인할 길이 없어진다
    const started = await writeBatch(db, batchId, {
      phase: 'start',
      willSend: plan.targets.length,
      products: [...productCount.values()],
      skipped: { notAvailable: plan.notAvailable, notPending: plan.notPending, missing: plan.missing },
    });
    if (!started) return res.status(500).json({ ...result, ok: false, error: '발송 이력을 저장하지 못해 보내지 않았습니다' });

    // 실패한 사람과 이유 (#324) — 화면 알림창에 그대로 보여 준다
    const failures: { userTail: string; products: string; reason: string }[] = [];
    // 실제로 처리(보냄·친구 아님)된 신청 — 화면은 이것만 「발송 완료」로 바꾼다
    const doneRefs: string[] = [];

    for (const t of plan.targets) {
      // 직렬로 보낸다. 병렬은 레이트리밋에 걸리고 어디까지 나갔는지도 흐려진다.
      const { result: r, reason } = await pushLineDetailed(t.userId, t.text);
      if (r === 'failed') {
        result.failed++;
        failures.push({
          userTail: t.userId.slice(-6),
          products: [...new Set(t.subs.map((s) => plan.titles.get(s.variantId) ?? ''))].filter(Boolean).join(', '),
          reason: reason ?? '알 수 없는 오류',
        });
        continue;
      }
      doneRefs.push(...t.subs.map((s) => s.ref));
      if (r === 'sent') result.sent++;
      else result.notFriend++;
      // 친구가 아니어도 기록한다 — 다시 보내도 같은 결과라 「발송 대기」에 계속 남지 않도록
      for (const s of t.subs) {
        await recordSends([t.userId], {
          campaignId: `journey_${JOURNEY}`,
          journey: JOURNEY,
          kind: 'transactional',
          ref: s.ref,
          name: '재입고 알림',
          utm: UTM,
          delivery: r,
        });
      }
    }

    // 실패 이유는 종류별로 모아 이력에 남긴다(사람 id 는 남기지 않는다)
    const reasons: Record<string, number> = {};
    for (const f of failures) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
    await writeBatch(db, batchId, {
      phase: 'done',
      sent: result.sent,
      notFriend: result.notFriend,
      failed: result.failed,
      failReasons: reasons,
    });

    console.log(`[LINE Restock] 수동 발송 ${result.sent}건 · 친구아님 ${result.notFriend} · 실패 ${result.failed}`);
    return res.status(200).json({ ...result, batchId, doneRefs, failures: failures.slice(0, 50) });
  } catch (error) {
    console.error('[LINE Restock] 발송 오류:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : '재입고 알림 발송 중 오류' });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST' && req.query.action === 'send') return sendSelected(req, res);
  if (req.method === 'POST') {
    try {
      return await subscribe(req, res);
    } catch (error) {
      console.error('[LINE Restock] 신청 오류:', error);
      return res.status(500).json({ error: 'failed' });
    }
  }
  if (req.method === 'GET' && req.query.view === 'soldout') return soldOutList(req, res);
  if (req.method === 'GET' && req.query.view === 'admin') {
    try {
      return await adminList(req, res);
    } catch (error) {
      console.error('[LINE Restock] 어드민 목록 오류:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
    }
  }
  if (req.method === 'GET') return preview(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}
