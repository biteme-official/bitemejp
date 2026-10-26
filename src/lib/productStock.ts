import type { ShopifyProduct } from "@/lib/shopify";

/**
 * 품절 구분 (#223) — 일시품절은 보여 주고 재입고 알림을 받고, 판매 종료는 숨긴다.
 *
 * Shopify 상품 태그로 정한다. 태그가 없으면 일시품절로 본다.
 *   - `販売終了`              상품 전체가 판매 종료
 *   - `販売終了:<옵션명>`      그 옵션만 판매 종료 (옵션명은 「M / ピンク」처럼 Shopify 옵션 표시 그대로)
 * `discontinued`·`단종` 도 같은 뜻으로 받는다.
 *
 * 판매 종료여도 재고가 남아 있으면 그대로 판다. 다 팔리면 목록에서 빠지고 재입고 알림도 없다.
 * api/line-restock.ts 에 같은 규칙이 한 벌 더 있다(서버는 src 를 import 하지 않는다) — 같이 고칠 것.
 */
const DISCONTINUED_TAGS = ["販売終了", "discontinued", "단종"];

function tagRule(tag: string): { variant: string | null } | null {
  const t = tag.trim();
  for (const key of DISCONTINUED_TAGS) {
    if (t.toLowerCase() === key.toLowerCase()) return { variant: null };
    const prefix = `${key}:`;
    if (t.toLowerCase().startsWith(prefix.toLowerCase())) return { variant: t.slice(prefix.length).trim() };
  }
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** 이 옵션이 판매 종료인가 (상품 태그 기준) */
export function isVariantDiscontinued(tags: string[] | undefined, variantTitle: string): boolean {
  for (const tag of tags ?? []) {
    const r = tagRule(tag);
    if (!r) continue;
    if (r.variant === null || norm(r.variant) === norm(variantTitle)) return true;
  }
  return false;
}

/** 옵션 중 하나라도 살 수 있으면 판매 중 */
export function isProductAvailable(p: ShopifyProduct): boolean {
  return p.node.variants.edges.some((e) => e.node.availableForSale);
}

/** 목록에서 뺄 상품 — 다 팔렸고, 품절 옵션이 전부 판매 종료(재입고 알림 받을 옵션이 없음) */
export function isHiddenSoldOut(p: ShopifyProduct): boolean {
  if (isProductAvailable(p)) return false;
  return p.node.variants.edges.every((e) => isVariantDiscontinued(p.node.tags, e.node.title));
}

/**
 * 출시 예정 (#248) — 아직 판매 전인 신상품. 「SOLD OUT」 대신 「COMING SOON」, 재입고 대신 오픈 알림.
 *
 * Shopify 상품 태그로 정한다.
 *   - `発売予定`              발매일 미정 → 「近日発売」
 *   - `発売予定:2026-11-01`   발매일 표시 → 「11月1日発売予定」 (날짜가 지났으면 「近日発売」)
 *   - `発売予定:2026-11-01 20:00`  발매 시각까지 → 「11月1日 20時発売予定」 (시각이 지났으면 「近日発売」)
 * `coming_soon`·`출시예정` 도 같은 뜻으로 받는다.
 *
 * 🔑 옵션이 하나라도 살 수 있게 되면 태그가 남아 있어도 보통 상품으로 보인다 — 오픈 때 태그 떼기를
 *    깜빡해도 「COMING SOON」이 살 수 있는 상품을 가리지 않게.
 *    단 발매일이 붙어 있고 그날이 아직 안 왔으면 재고가 있어도 「COMING SOON」을 지킨다 — 재고가 자동 연동돼
 *    발매 전에 판매가 열려 버리는 일을 막으려고. 발매일(JST) 0시, 시각이 있으면 그 시각이 되면 위 규칙대로 저절로 열린다.
 * api/line-launch.ts 에 같은 규칙이 한 벌 더 있다(서버는 src 를 import 하지 않는다) — 같이 고칠 것.
 */
const LAUNCH_TAGS = ["発売予定", "coming_soon", "출시예정"];

export interface LaunchInfo {
  /** 발매일 `YYYY-MM-DD` 또는 `YYYY-MM-DD HH:MM` (JST). 미정이거나 지났으면 null */
  date: string | null;
}

/** `2026-11-01` · `2026-11-01 20:00` (`9:30` 처럼 한 자리 시도 받아 두 자리로) — 형식이 틀리면 null */
function parseLaunchDate(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  if (m[2] === undefined) return m[1];
  const h = Number(m[2]);
  if (h > 23 || Number(m[3]) > 59) return null;
  return `${m[1]} ${String(h).padStart(2, "0")}:${m[3]}`;
}

/** 지금 JST `YYYY-MM-DD HH:MM` — 발매일 문자열과 그대로 비교한다(날짜만인 `2026-11-01` 은 `2026-11-01 00:00` 보다 앞이라 그날 0시에 열린다) */
function nowJst(now: number): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

/** 출시 예정 태그 — 판매 여부와 상관없이 태그만 본다 */
export function getLaunchTag(tags: string[] | undefined, now: number = Date.now()): LaunchInfo | null {
  for (const raw of tags ?? []) {
    const t = raw.trim();
    for (const key of LAUNCH_TAGS) {
      if (t.toLowerCase() === key.toLowerCase()) return { date: null };
      if (!t.toLowerCase().startsWith(`${key.toLowerCase()}:`)) continue;
      const date = parseLaunchDate(t.slice(key.length + 1).trim());
      if (!date) return { date: null };
      const cur = nowJst(now);
      // 날짜만이면 그날 하루는 표시, 시각이 있으면 그 시각까지만
      const passed = date.length > 10 ? date <= cur : date < cur.slice(0, 10);
      return { date: passed ? null : date };
    }
  }
  return null;
}

/** 발매일이 아직 안 온 출시 예정 상품 — 재고가 있어도 팔지 않는다 */
export function isLaunchHeld(tags: string[] | undefined, now: number = Date.now()): boolean {
  const date = getLaunchTag(tags, now)?.date;
  if (!date) return false;
  return date > nowJst(now);
}

/** 지금 「COMING SOON」으로 보여 줄 상품인가 — 태그가 있고 살 수 있는 옵션이 하나도 없음(발매일 전이면 재고 무관) */
export function getUpcomingLaunch(node: {
  tags?: string[];
  variants: { edges: { node: { availableForSale: boolean } }[] };
}): LaunchInfo | null {
  if (!isLaunchHeld(node.tags) && node.variants.edges.some((e) => e.node.availableForSale)) return null;
  return getLaunchTag(node.tags);
}

/** 「11月1日発売予定」 · 「11月1日 20時発売予定」 · 「11月1日 20時30分発売予定」 · 「近日発売」 */
export function launchLabel(info: LaunchInfo): string {
  if (!info.date) return "近日発売";
  const [day, time] = info.date.split(" ");
  const [, m, d] = day.split("-").map(Number);
  if (!time) return `${m}月${d}日発売予定`;
  const [h, min] = time.split(":").map(Number);
  return `${m}月${d}日 ${h}時${min ? `${min}分` : ""}発売予定`;
}
