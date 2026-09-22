import { fetchBanners, ShopifyBanner, storefrontApiRequest } from "@/lib/shopify";

/**
 * 메인 배너 — 어드민 「메인 배너」 탭에서 직접 관리하는 자체 데이터 (#194).
 *
 * Shopify 메타오브젝트(2603)를 거치지 않는다. 문서 하나(`banners.json`)를 Supabase Storage 에 두고
 * `/api/home-banners` 가 읽고 쓴다. 이미지도 같은 버킷에 올린다.
 *
 * 문구는 이미지에 박지 않고 HTML 로 얹는다(하영 2026-09-22 "html처럼"). 그래서 PC·모바일 배치를
 * 따로 잡을 수 있고, 각 요소의 자리는 고정이다 — 배지·부제·헤드라인은 위에서부터 쌓이고
 * CTA 는 항상 아래 같은 자리(헤드라인이 한 줄이든 세 줄이든 버튼 위치는 안 움직인다).
 *
 * 문서가 아직 없으면(`source: 'none'`) 프론트는 예전처럼 Shopify 메타오브젝트를 읽는다 —
 * 어드민에서 처음 저장하는 순간 자체 데이터로 넘어간다.
 */

export type MobileRatio = "4:3" | "1:1" | "strip";
export type TextTone = "dark" | "light";
export type CtaStyle = "text" | "button";

export interface HomeBannerText {
  badge: string;
  subtext: string;
  headline: string;
  cta: string;
  tone: TextTone;
  ctaStyle: CtaStyle;
}

/**
 * 상품 사진으로 만든 배너(#194 — "상품 링크 주면 썸네일로"). 디자이너 배너 없이 상품 이미지 한 장을
 * 오른쪽에 놓고 배경색을 채운다. 상품 썸네일은 위 25~30% 에 제목 글자가 박혀 있어 `cropTop` 만큼 위를
 * 잘라낸다(Shopify CDN `crop=bottom` 이 잘라 주므로 이미지 가공 서버가 없다).
 */
export interface HomeBannerPhoto {
  /** 원본 이미지 URL(Shopify CDN) */
  url: string;
  width: number;
  height: number;
  /** 위에서 잘라낼 비율 0~0.6 */
  cropTop: number;
}

export interface HomeBanner {
  id: string;
  /** 관리용 이름(화면엔 안 나옴) */
  name: string;
  enabled: boolean;
  /** ISO 8601. 비우면 상시 */
  startAt: string | null;
  endAt: string | null;
  link: string | null;
  /** PC 이미지 1200×504. photo 가 있으면 안 쓴다 */
  pcImage: string | null;
  /** 상품 사진 모드 — 있으면 pcImage/mobileImage 대신 이걸 오른쪽에 놓는다 */
  photo: HomeBannerPhoto | null;
  /** 모바일 이미지(settings.mobileRatio 비율). 없으면 PC 이미지를 배경색 위에 얹는다 */
  mobileImage: string | null;
  /** 배경색 — 모바일에서 PC 이미지 바깥을 채우는 색. 업로드 때 이미지 모서리에서 자동으로 뽑는다 */
  bg: string;
  text: HomeBannerText;
}

export interface HomeBannersSettings {
  /** 모바일 배너 틀 비율. strip = PC 이미지 가로형 그대로 */
  mobileRatio: MobileRatio;
}

export interface HomeBannersDoc {
  version: 1;
  updatedAt: string;
  settings: HomeBannersSettings;
  banners: HomeBanner[];
}

export const DEFAULT_SETTINGS: HomeBannersSettings = { mobileRatio: "strip" };

export const EMPTY_TEXT: HomeBannerText = {
  badge: "",
  subtext: "",
  headline: "",
  cta: "",
  tone: "dark",
  ctaStyle: "text",
};

export function newBannerId(): string {
  return `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyBanner(): HomeBanner {
  return {
    id: newBannerId(),
    name: "",
    enabled: true,
    startAt: null,
    endAt: null,
    link: null,
    pcImage: null,
    photo: null,
    mobileImage: null,
    bg: "#f5f5f5",
    text: { ...EMPTY_TEXT },
  };
}

/** 위를 잘라낸 상품 사진 URL. 폭은 배너용으로 1000 이면 충분 */
export function photoUrl(p: HomeBannerPhoto, width = 1000): string {
  const crop = Math.min(0.6, Math.max(0, p.cropTop));
  const h = Math.max(1, Math.round(p.height * (1 - crop)));
  const sep = p.url.includes("?") ? "&" : "?";
  return `${p.url}${sep}width=${Math.min(width, p.width)}&height=${Math.round(h * Math.min(width, p.width) / p.width)}&crop=bottom`;
}

export function bannerImage(b: HomeBanner): boolean {
  return Boolean(b.photo?.url || b.pcImage);
}

export interface ProductForBanner {
  id: string;
  title: string;
  url: string;
  images: { url: string; width: number; height: number }[];
}

/** 상품 링크(https://biteme.co.jp/product/1234…) 또는 숫자 ID → 상품 제목·이미지 목록 */
export async function fetchProductForBanner(input: string): Promise<ProductForBanner | null> {
  const m = input.trim().match(/(?:\/product\/|^)(\d{6,})/);
  if (!m) return null;
  const gid = `gid://shopify/Product/${m[1]}`;
  const data = await storefrontApiRequest(
    `query ($id: ID!) { product(id: $id) { id title images(first: 12) { edges { node { url width height } } } } }`,
    { id: gid },
  );
  const node = data?.data?.product;
  if (!node) return null;
  return {
    id: node.id,
    title: node.title,
    url: `https://biteme.co.jp/product/${m[1]}`,
    images: (node.images?.edges ?? []).map((e: { node: { url: string; width: number; height: number } }) => e.node),
  };
}

export function hasText(t: HomeBannerText): boolean {
  return Boolean(t.headline || t.subtext || t.cta || t.badge);
}

/** 지금 이 배너를 보여줄 때인지 (예약 노출). 문서는 60초 엣지 캐시라 그 오차는 있다 */
export function isHomeBannerLive(b: HomeBanner, now: number = Date.now()): boolean {
  if (!b.enabled) return false;
  if (!bannerImage(b)) return false;
  if (b.startAt && now < Date.parse(b.startAt)) return false;
  if (b.endAt && now > Date.parse(b.endAt)) return false;
  return true;
}

export type HomeBannersSource =
  | { source: "doc"; doc: HomeBannersDoc }
  | { source: "none" };

/** 공개 읽기. 문서가 없거나 API 가 죽어도 throw 하지 않고 `none` — 그러면 Shopify 로 간다 */
export async function fetchHomeBanners(): Promise<HomeBannersSource> {
  try {
    const res = await fetch("/api/home-banners");
    if (!res.ok) return { source: "none" };
    const json = (await res.json()) as HomeBannersSource;
    if (json.source === "doc" && Array.isArray(json.doc?.banners)) return json;
    return { source: "none" };
  } catch {
    return { source: "none" };
  }
}

/**
 * Shopify 메타오브젝트 배너 → 자체 배너. 어드민 첫 진입(문서 없음) 때 한 번 채워 주는 용도.
 * 이미지는 Shopify CDN 주소를 그대로 쓴다(옮길 필요 없음). 예약·정렬·문구·링크도 그대로.
 * 이미 지난 배너(end_at 과거)는 가져오지 않는다.
 */
/** Shopify 배지 드롭다운 값 → 화면 표기. 목록에 없는 값은 대문자 그대로 */
const BADGE_LABELS: Record<string, string> = {
  new: "NEW",
  "best-seller": "BEST SELLER",
  bestseller: "BEST SELLER",
  best: "BEST SELLER",
  sale: "SALE",
  limited: "LIMITED",
  restock: "RESTOCK",
};

export function fromShopifyBanner(b: ShopifyBanner): HomeBanner {
  const fields = b.fields;
  const iso = (v: string | undefined): string | null => {
    if (!v) return null;
    const raw = v.trim();
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
    const t = Date.parse(hasZone ? raw : `${raw}+09:00`);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };
  return {
    id: newBannerId(),
    name: b.text.headline || fields["title"] || b.handle,
    enabled: true,
    startAt: iso(fields["start_at"] ?? fields["start_date"]),
    endAt: iso(fields["end_at"] ?? fields["end_date"]),
    link: b.linkUrl,
    pcImage: b.image?.url ?? null,
    photo: null,
    mobileImage: null,
    bg: "#f5f5f5",
    text: {
      badge: b.text.badge ? BADGE_LABELS[b.text.badge.toLowerCase()] ?? b.text.badge.toUpperCase() : "",
      subtext: b.text.subtext ?? "",
      headline: b.text.headline ?? "",
      cta: b.text.buttonLabel ?? "",
      tone: "dark",
      ctaStyle: "text",
    },
  };
}

export async function importFromShopify(): Promise<HomeBanner[]> {
  const now = Date.now();
  const list = await fetchBanners(25, true);
  return list
    .filter((b) => b.image)
    .map(fromShopifyBanner)
    .filter((b) => !b.endAt || Date.parse(b.endAt) > now);
}
