/**
 * /api/line-launch — 출시 예정 상품 오픈 LINE 알림 (#248)
 *
 * 재입고 알림(api/line-restock.ts)과 같은 구조이고, 옵션이 아니라 **상품 단위**다.
 *   - POST  신청. 「COMING SOON」 상품을 보던 LINE 로그인 고객이 「発売をLINEで受け取る」를 누르면 온다.
 *   - POST  ?action=send  발송. 어드민 「오픈 알림」 탭에서 운영자가 고른 상품의 신청자에게만 LINE 을 보낸다.
 *   - GET   ?view=admin   어드민 목록.
 *
 * 출시 예정 = Shopify 상품 태그 `発売予定` 또는 `発売予定:YYYY-MM-DD` (`coming_soon`·`출시예정` 도 같은 뜻).
 * src/lib/productStock.ts 의 getLaunchTag 와 같은 규칙 — 같이 고칠 것.
 * 「오픈」 = 상품이 판매 중(ACTIVE)이고 옵션이 하나라도 구매 가능. 태그를 떼지 않아도 오픈으로 본다.
 *   단 `発売予定:YYYY-MM-DD` 의 발매일(JST)이 아직 안 왔으면 재고가 있어도 오픈 전이다(사이트도 「COMING SOON」).
 *
 * 🔴 자동 발송은 하지 않는다 — 재입고 알림(#227)과 같은 이유. 재고 수정 실수에도 바로 나가 버린다.
 *
 * 저장소는 Supabase `events` 그대로.
 *   - 신청   event_type = `line_launch_sub` · session_id = `line:<userId>`
 *   - 발송   `line_send` (journey = `launch`, ref = 신청 행을 가리키는 키)
 * 신청 한 건에 알림은 한 통이다.
 *
 * 🔴 신청자의 LINE userId 는 서명된 `lineSessionToken` 에서만 꺼낸다(재입고 알림과 같은 검증).
 * 마케팅 빈도 제한은 걸지 않는다(`kind: transactional`) — 고객이 직접 달라고 한 알림이다.
 *
 * ⚠️ 재입고 알림과 같은 스위치 `LINE_RESTOCK_ENABLED=1` 일 때만 실제로 보낸다(꺼 두면 미리보기만).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SEND_EVENT, adminGraphQL, fetchQuota, getAdminToken, inQuietHours, recordSends, supabase } from './line-campaign.js';
import {
  adminOnly,
  getCorsOrigin,
  isFriend,
  lineDisplayName,
  oneLine,
  pushLine,
  readAll,
  verifySessionToken,
  type Db,
} from './line-restock.js';

export const LAUNCH_SUB_EVENT = 'line_launch_sub';
const JOURNEY = 'launch';
const UTM = 'line_launch';

/** 이보다 오래된 신청은 보지 않는다 */
const SUB_TTL_DAYS = 180;
/** 한 번 누를 때 보낼 수 있는 최대 인원 — 함수 시간 안에 끝나도록 */
const MAX_PER_RUN = 200;

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

// ─── 출시 예정 태그 (src/lib/productStock.ts 와 같은 규칙) ───────────────────────

const LAUNCH_TAGS = ['発売予定', 'coming_soon', '출시예정'];

/** 태그가 없으면 null. 날짜가 없거나 형식이 틀리면 date null */
function launchTag(tags: string[]): { date: string | null } | null {
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    for (const key of LAUNCH_TAGS.map((k) => k.toLowerCase())) {
      if (t === key) return { date: null };
      if (!t.startsWith(`${key}:`)) continue;
      const date = t.slice(key.length + 1).trim();
      return { date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
    }
  }
  return null;
}

/** 발매일이 아직 안 왔는가 — 재고가 있어도 오픈 전으로 본다 (src/lib/productStock.ts isLaunchHeld 와 같은 규칙) */
function launchHeld(date: string | null, now: number = Date.now()): boolean {
  if (!date) return false;
  return date > new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

// ─── Shopify ─────────────────────────────────────────────────────────────────

interface ProductState {
  productId: string;
  title: string;
  titleKo: string | null;
  /** 판매 중(ACTIVE)이고 옵션이 하나라도 구매 가능 */
  open: boolean;
  tagged: boolean;
  launchDate: string | null;
}

interface ProductNodeResponse {
  data?: {
    product: {
      id: string;
      title: string;
      status: string;
      tags: string[];
      variants: { nodes: { availableForSale: boolean }[] };
    } | null;
  };
  errors?: unknown;
}

/** 신청 확인용 — 상품 하나 */
async function fetchProduct(token: string, productId: string): Promise<ProductState | null> {
  const res = await adminGraphQL<ProductNodeResponse>(
    token,
    `query($id: ID!) {
      product(id: $id) { id title status tags variants(first: 100) { nodes { availableForSale } } }
    }`,
    { id: productId },
  );
  if (!res?.data) throw new Error(`상품 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 200)}`);
  const p = res.data.product;
  if (!p) return null;
  const tag = launchTag(p.tags ?? []);
  return {
    productId: p.id,
    title: p.title,
    titleKo: null,
    open: p.status === 'ACTIVE' && !launchHeld(tag?.date ?? null) && p.variants.nodes.some((v) => v.availableForSale),
    tagged: !!tag,
    launchDate: tag?.date ?? null,
  };
}

interface ProductVariantsPage {
  data?: {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
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

/**
 * 전 상품의 오픈 여부. 옵션 단위로 훑어 상품별로 묶는다(재입고 「지금 품절 목록」과 같은 방식).
 * 상품 + 옵션 중첩 조회는 쿼리 비용 한도에 걸려서 이렇게 한다.
 */
async function fetchAllProducts(token: string): Promise<Map<string, ProductState>> {
  const out = new Map<string, ProductState>();
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const res: ProductVariantsPage | null = await adminGraphQL<ProductVariantsPage>(
      token,
      `query($after: String) {
        productVariants(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            availableForSale
            product {
              id title status tags
              nameKo: metafield(namespace: "custom", key: "name_ko") { value }
            }
          }
        }
      }`,
      { after },
    );
    const conn: NonNullable<ProductVariantsPage['data']>['productVariants'] | undefined = res?.data?.productVariants;
    // 🔴 조회가 실패했는데 빈 결과로 넘기면 「오픈한 상품 없음」으로 읽힌다. 실패는 실패로 던진다.
    if (!conn) throw new Error(`상품 목록 조회 실패: ${JSON.stringify(res?.errors ?? res).slice(0, 200)}`);
    for (const v of conn.nodes) {
      const p = v.product;
      const tag = launchTag(p.tags ?? []);
      const cur = out.get(p.id) ?? {
        productId: p.id,
        title: p.title,
        titleKo: p.nameKo?.value?.trim() || null,
        open: false,
        tagged: !!tag,
        launchDate: tag?.date ?? null,
      };
      if (p.status === 'ACTIVE' && v.availableForSale && !launchHeld(cur.launchDate)) cur.open = true;
      out.set(p.id, cur);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// ─── 신청 기록 ────────────────────────────────────────────────────────────────

interface Subscription {
  lineUserId: string;
  productId: string;
  productTitle: string;
  createdAt: string;
  /** 발송 기록의 ref — 이 신청을 가리키는 키. 다시 신청하면 새 키가 된다. */
  ref: string;
}

function subRef(productId: string, createdAt: string): string {
  return `launch:${productId.split('/').pop()}@${createdAt}`;
}

interface SendLog {
  at: string;
  delivery: string;
}

/** 신청(같은 사람·상품은 가장 최근 한 건)과, ref 별 발송 기록 */
async function loadSubscriptions(db: Db, now: number): Promise<{ subs: Subscription[]; sentByRef: Map<string, SendLog> }> {
  const since = new Date(now - SUB_TTL_DAYS * 86_400_000).toISOString();
  const [rows, sends] = await Promise.all([
    readAll<{ session_id: string; created_at: string; properties: { productId?: string; productTitle?: string } | null }>(
      db, LAUNCH_SUB_EVENT, 'session_id, created_at, properties', since,
    ),
    readAll<{ created_at: string; properties: { journey?: string; ref?: string; delivery?: string } | null }>(
      db, SEND_EVENT, 'created_at, properties', since,
    ),
  ]);

  const sentByRef = new Map<string, SendLog>();
  for (const s of sends) {
    if (s.properties?.journey === JOURNEY && s.properties.ref) {
      sentByRef.set(s.properties.ref, { at: s.created_at, delivery: s.properties.delivery ?? 'sent' });
    }
  }

  const latest = new Map<string, Subscription>();
  for (const row of rows) {
    const { productId, productTitle } = row.properties ?? {};
    if (!row.session_id.startsWith('line:') || !productId) continue;
    const lineUserId = row.session_id.slice(5);
    latest.set(`${lineUserId}|${productId}`, {
      lineUserId,
      productId,
      productTitle: productTitle ?? '',
      createdAt: row.created_at,
      ref: subRef(productId, row.created_at),
    });
  }
  return { subs: [...latest.values()], sentByRef };
}

// ─── 문안 ────────────────────────────────────────────────────────────────────

function productUrl(productId: string): string {
  const id = productId.split('/').pop();
  return `https://biteme.co.jp/product/${id}?utm_source=line&utm_medium=line&utm_campaign=${UTM}`;
}

export function buildLaunchMessage(items: { productId: string; title: string }[]): string {
  const lines = ['お待たせしました🐾', 'BITE ME JAPANです。', ''];
  if (items.length === 1) {
    lines.push(`ご登録いただいた「${oneLine(items[0].title)}」の`, '販売がスタートしました！');
  } else {
    lines.push('ご登録いただいた商品の販売がスタートしました！');
    for (const i of items) lines.push(`・「${oneLine(i.title)}」`);
  }
  lines.push('', '人気のカラー・サイズは', '早めに売り切れることがございます。', 'お早めにチェックしてください。', '');
  for (const i of items) {
    lines.push(items.length === 1 ? '▼ 商品を見る' : `▼ ${oneLine(i.title)}`, productUrl(i.productId));
  }
  return lines.join('\n');
}

/** 대시보드용 문구 — 실제 발송 함수로 만든다. 상품 자리만 자리표시자다 */
export function launchCopy(): { label: string | null; text: string }[] {
  return [{ label: null, text: buildLaunchMessage([{ productId: '〔상품ID〕', title: '〔상품명〕' }]) }];
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
  const { lineSessionToken, productId } = (payload ?? {}) as Record<string, unknown>;

  const session = verifySessionToken(lineSessionToken, secret);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  if (typeof productId !== 'string' || !PRODUCT_GID.test(productId)) return res.status(400).json({ error: 'bad_request' });

  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });

  // 진짜 출시 예정 상품인지 확인한다. 지어낸 id·일반 상품으로 신청 행이 쌓이지 않게.
  const state = await fetchProduct(await getAdminToken(), productId);
  if (!state) return res.status(404).json({ error: 'not_found' });
  if (state.open) return res.status(409).json({ error: 'on_sale' });
  if (!state.tagged) return res.status(409).json({ error: 'not_upcoming' });

  // 이미 신청해 두고 아직 알림을 못 받은 상태면 행을 또 쌓지 않는다
  const { subs, sentByRef } = await loadSubscriptions(db, Date.now());
  const already = subs.some(
    (s) => s.lineUserId === session.lineUserId && s.productId === productId && !sentByRef.has(s.ref),
  );

  if (!already) {
    const { error } = await db.from('events').insert({
      event_type: LAUNCH_SUB_EVENT,
      session_id: `line:${session.lineUserId}`,
      properties: { productId, productTitle: state.title },
      page_path: `/product/${productId.split('/').pop()}`,
      referrer: null,
    });
    if (error) {
      console.error('[LINE Launch] 신청 저장 실패:', error.message);
      return res.status(500).json({ error: 'failed' });
    }
  }

  const friend = await isFriend(session.lineUserId);
  return res.status(200).json({ ok: true, already, friend });
}

// ─── GET ?view=admin: 어드민 「오픈 알림」 탭 ──────────────────────────────────

export type LaunchStatus = 'waiting' | 'ready' | 'sent' | 'not_friend' | 'gone';

export interface LaunchAdminRow {
  ref: string;
  createdAt: string;
  displayName: string | null;
  /** 끝 6자리만 — 화면에 userId 전체를 띄우지 않는다 */
  userTail: string;
  productId: string;
  productTitle: string;
  /**
   * waiting    아직 판매 전
   * ready      판매 시작됨 — 화면에서 골라 보내면 나간다
   * sent       알림 보냄
   * not_friend 보냈지만 친구가 아니라 닿지 않음
   * gone       상품이 삭제됨
   */
  status: LaunchStatus;
  sentAt: string | null;
}

export interface LaunchAdminProduct {
  productId: string;
  title: string;
  titleKo: string | null;
  /** before 판매 전 · open 판매 중 · gone 삭제됨 */
  state: 'before' | 'open' | 'gone';
  /** 출시 예정 태그가 붙어 있는가 */
  tagged: boolean;
  launchDate: string | null;
  /** 아직 알림을 못 받은 신청 */
  waiting: number;
  sent: number;
  notFriend: number;
}

async function adminList(req: VercelRequest, res: VercelResponse) {
  if (!adminOnly(req)) return res.status(401).json({ error: 'Unauthorized' });
  const db = supabase();
  if (!db) return res.status(500).json({ error: 'SUPABASE 미설정' });

  const now = Date.now();
  const [{ subs, sentByRef }, all] = await Promise.all([
    loadSubscriptions(db, now),
    getAdminToken().then(fetchAllProducts),
  ]);

  const userIds = [...new Set(subs.map((s) => s.lineUserId))].slice(0, 300);
  const names = new Map<string, string | null>();
  for (let i = 0; i < userIds.length; i += 10) {
    const chunk = userIds.slice(i, i + 10);
    const got = await Promise.all(chunk.map(lineDisplayName));
    chunk.forEach((u, k) => names.set(u, got[k]));
  }

  const rows: LaunchAdminRow[] = subs
    .map((s) => {
      const sent = sentByRef.get(s.ref);
      const p = all.get(s.productId);
      const status: LaunchStatus = sent
        ? sent.delivery === 'not-friend' ? 'not_friend' : 'sent'
        : !p ? 'gone' : p.open ? 'ready' : 'waiting';
      return {
        ref: s.ref,
        createdAt: s.createdAt,
        displayName: names.get(s.lineUserId) ?? null,
        userTail: s.lineUserId.slice(-6),
        productId: s.productId,
        productTitle: p?.title ?? s.productTitle,
        status,
        sentAt: sent?.at ?? null,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // 상품 목록 = 지금 출시 예정 태그가 붙은 상품 + 신청이 있었던 상품
  const products = new Map<string, LaunchAdminProduct>();
  const ensure = (productId: string, fallbackTitle: string): LaunchAdminProduct => {
    const cur = products.get(productId);
    if (cur) return cur;
    const p = all.get(productId);
    const next: LaunchAdminProduct = {
      productId,
      title: p?.title ?? fallbackTitle,
      titleKo: p?.titleKo ?? null,
      state: !p ? 'gone' : p.open ? 'open' : 'before',
      tagged: p?.tagged ?? false,
      launchDate: p?.launchDate ?? null,
      waiting: 0,
      sent: 0,
      notFriend: 0,
    };
    products.set(productId, next);
    return next;
  };
  for (const p of all.values()) if (p.tagged) ensure(p.productId, p.title);
  for (const r of rows) {
    const p = ensure(r.productId, r.productTitle);
    if (r.status === 'waiting' || r.status === 'ready') p.waiting++;
    else if (r.status === 'sent') p.sent++;
    else if (r.status === 'not_friend') p.notFriend++;
  }

  // 판매 시작됐는데 아직 못 보낸 상품이 맨 위, 그다음 대기 인원순
  const order = (p: LaunchAdminProduct) => (p.state === 'open' && p.waiting > 0 ? 0 : p.state === 'before' ? 1 : 2);
  const productList = [...products.values()].sort(
    (a, b) => order(a) - order(b) || b.waiting - a.waiting || (a.launchDate ?? '9').localeCompare(b.launchDate ?? '9'),
  );

  return res.status(200).json({
    products: productList,
    rows,
    enabled: process.env.LINE_RESTOCK_ENABLED === '1',
    quietHours: inQuietHours(new Date(now)),
    maxPerSend: MAX_PER_RUN,
    ttlDays: SUB_TTL_DAYS,
  });
}

// ─── 발송 (어드민 수동) ────────────────────────────────────────────────────────

/**
 * POST ?action=send — 어드민이 고른 상품의 신청자에게 보낸다.
 *   body { productIds: string[], dryRun?: boolean }
 *   dryRun 이면 보내지 않고 몇 명에게 어떤 문안이 나가는지만 돌려준다(화면의 확인 단계).
 * 🔴 화면이 「판매 시작」이라고 보여 준 뒤 그새 내려갔을 수 있다 — 보낼 때 상품 상태를 다시 본다.
 */
async function sendSelected(req: VercelRequest, res: VercelResponse) {
  if (!adminOnly(req)) return res.status(401).json({ error: 'Unauthorized' });

  let payload: unknown = req.body ?? {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: 'bad_request' });
    }
  }
  const { productIds, dryRun } = (payload ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(productIds) ||
    productIds.length === 0 ||
    productIds.length > 50 ||
    !productIds.every((p) => typeof p === 'string' && PRODUCT_GID.test(p))
  ) {
    return res.status(400).json({ error: '보낼 상품을 골라 주세요' });
  }
  const selected = new Set(productIds as string[]);
  const isDry = dryRun === true;
  const enabled = process.env.LINE_RESTOCK_ENABLED === '1';
  if (!isDry && !enabled) return res.status(409).json({ error: 'LINE_RESTOCK_ENABLED 가 꺼져 있어 보낼 수 없습니다' });

  // 🔴 중복 방지가 발송 기록 위에 선다. 기록이 없으면 같은 사람에게 몇 번이고 나간다.
  const db = supabase();
  if (!db) return res.status(500).json({ error: '발송 기록 저장소가 없어 중단했습니다' });

  try {
    const { subs, sentByRef } = await loadSubscriptions(db, Date.now());
    const token = await getAdminToken();
    const states = new Map<string, ProductState | null>();
    for (const id of selected) states.set(id, await fetchProduct(token, id));

    const pending = subs.filter((s) => selected.has(s.productId) && !sentByRef.has(s.ref));
    const notOpen = [...selected].filter((id) => !states.get(id)?.open);
    const ready = pending.filter((s) => states.get(s.productId)?.open);

    // 한 사람에게 한 통 — 고른 상품이 여러 개면 한 메시지에 묶는다
    const byUser = new Map<string, Subscription[]>();
    for (const s of ready) byUser.set(s.lineUserId, [...(byUser.get(s.lineUserId) ?? []), s]);
    const targets = [...byUser.entries()].map(([userId, list]) => ({
      userId,
      subs: list,
      text: buildLaunchMessage(list.map((s) => ({ productId: s.productId, title: states.get(s.productId)!.title }))),
    }));

    const result = {
      ok: true,
      dryRun: isDry,
      enabled,
      quietHours: inQuietHours(new Date()),
      selected: selected.size,
      /** 고른 상품 중 아직 판매 전·삭제됨 — 그 상품 신청자에겐 보내지 않는다 */
      notOpen: notOpen.length,
      ready: ready.length,
      willSend: targets.length,
      sent: 0,
      notFriend: 0,
      failed: 0,
      samples: targets.slice(0, 2).map((t) => t.text),
    };
    if (targets.length > MAX_PER_RUN) {
      return res.status(400).json({ ...result, ok: false, error: `한 번에 ${MAX_PER_RUN}명까지 보낼 수 있습니다 — 상품을 나눠서 골라 주세요` });
    }
    if (isDry || targets.length === 0) return res.status(200).json(result);

    // LINE 월 발송 한도. 모자라면 아예 보내지 않는다(재입고 알림과 같은 이유)
    const quota = await fetchQuota().catch(() => null);
    if (quota && quota.remaining !== null && quota.remaining < targets.length) {
      console.error(`[LINE Launch] 🔴 월 한도 부족 — 남은 ${quota.remaining}통 < 보낼 ${targets.length}명. 보류합니다`);
      return res.status(409).json({ ...result, ok: false, error: `LINE 월 발송 한도 부족 — 남은 ${quota.remaining}통` });
    }

    for (const t of targets) {
      // 직렬로 보낸다. 병렬은 레이트리밋에 걸리고 어디까지 나갔는지도 흐려진다.
      const r = await pushLine(t.userId, t.text);
      if (r === 'failed') {
        result.failed++;
        continue;
      }
      if (r === 'sent') result.sent++;
      else result.notFriend++;
      // 친구가 아니어도 기록한다 — 다시 보내도 같은 결과라 「대기」에 계속 남지 않도록
      for (const s of t.subs) {
        await recordSends([t.userId], {
          campaignId: `journey_${JOURNEY}`,
          journey: JOURNEY,
          kind: 'transactional',
          ref: s.ref,
          name: '오픈 알림',
          utm: UTM,
          delivery: r,
        });
      }
    }

    console.log(`[LINE Launch] 수동 발송 ${result.sent}건 · 친구아님 ${result.notFriend} · 실패 ${result.failed}`);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[LINE Launch] 발송 오류:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : '오픈 알림 발송 중 오류' });
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
      console.error('[LINE Launch] 신청 오류:', error);
      return res.status(500).json({ error: 'failed' });
    }
  }
  if (req.method === 'GET' && req.query.view === 'admin') {
    try {
      return await adminList(req, res);
    } catch (error) {
      console.error('[LINE Launch] 어드민 목록 오류:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
