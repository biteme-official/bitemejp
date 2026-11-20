import { useEffect, useRef, useState } from "react";

// GEO 상세페이지(업체 변환본: 이미지 + 글자 겹침). 원본 HTML은 public/geo/ja/{상품 숫자 ID}.html 에 그대로 둔다.
// 목록에 없는 상품은 기존 Shopify 설명을 쓴다. (없는 파일도 SPA 폴백으로 200이 오므로 목록으로 판단)
export const GEO_DETAIL_IDS = new Set([
  "10150718865721", // コンフォートハーネスv2
  "10150718800185", // コンフォートリード v2
  "10201780683065", // ジェリーベアLEDライト
  "10150719291705", // ジャンピングブギ
  "15407342420281", // ポイントケア 三角スリッカー
  "10346561569081", // ゼロガードマット
]);

type Roles = Record<string, [number, number]>;

// 원본 HTML의 글자 크기 맞춤 스크립트(fit/settle)를 그대로 옮긴 것.
// CSP(unsafe-eval 없음) 때문에 원본 스크립트를 실행하지 않고, 역할별 크기표(ROLES)만 읽어 쓴다.
function fit(el: HTMLElement, max: number): number {
  const span = el.firstElementChild as HTMLElement, W = el.clientWidth;
  const V = el.classList.contains("vert"), Hh = el.clientHeight;
  const ok = (s: number) => { el.style.fontSize = s + "px"; return V ? span.scrollHeight <= Hh + .5 : span.scrollWidth <= W + .5; };
  if (ok(max)) return max;
  let lo = 3, hi = max;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return lo;
}

function applySizes(main: HTMLElement, roles: Roles) {
  const k = Math.min(800, main.clientWidth) / 800;
  if (!k) return;
  const by: Record<string, HTMLElement[]> = {};
  for (const el of main.querySelectorAll<HTMLElement>(".text-overlay")) (by[el.dataset.r!] ??= []).push(el);
  for (const [r, els] of Object.entries(by)) {
    if (!roles[r]) continue;
    const [base, lh] = roles[r];
    const own: Record<string, number> = {};
    for (const e of els) own[e.id] = fit(e, base * k);
    // 역할 크기 = 구성원 맞춤 크기의 중앙값, 같은 섹션의 같은 역할은 가장 작은 크기로 통일
    const sv = Object.values(own).sort((a, b) => a - b), size = sv[Math.floor((sv.length - 1) / 2)];
    const grp: Record<string, number> = {};
    for (const e of els) { const sid = e.closest("section")!.id; grp[sid] = Math.min(grp[sid] ?? 1e9, own[e.id]); }
    for (const e of els) {
      const sz = Math.min(size, grp[e.closest("section")!.id]);
      e.style.fontSize = sz + "px";
      e.style.lineHeight = (Number(e.dataset.lh || lh) * sz) + "px";
    }
  }
}

export interface GeoDetailProps {
  productId: string;
  onJsonLd?: (product: Record<string, unknown>) => void;
  fallback: React.ReactNode;
}

export function GeoDetail({ productId, onJsonLd, fallback }: GeoDetailProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let fontStyle: HTMLStyleElement | null = null;
    let observer: ResizeObserver | null = null;

    (async () => {
      try {
        const res = await fetch(`/geo/ja/${productId}.html`);
        if (!res.ok) throw new Error(String(res.status));
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const srcMain = doc.querySelector("main");
        const rolesMatch = doc.body.innerHTML.match(/const ROLES\s*=\s*(\{[\s\S]*?\});/);
        if (!srcMain || !rolesMatch) throw new Error("bad geo html");
        if (cancelled) return;
        const roles: Roles = JSON.parse(rolesMatch[1]);

        // 글꼴: 이 상품 전용 이름으로 바꿔 문서에 등록(Shadow DOM 안의 @font-face 는 적용 안 됨)
        let css = [...doc.querySelectorAll("style")].map(s => s.textContent || "").join("\n");
        const families = [...new Set([...css.matchAll(/@font-face\s*\{[^}]*font-family:\s*'([^']+)'/g)].map(m => m[1]))];
        for (const f of families) css = css.split(`'${f}'`).join(`'${f}-${productId}'`);
        const fontFaces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
        fontStyle = document.createElement("style");
        fontStyle.dataset.geoDetail = productId;
        fontStyle.textContent = fontFaces.join("\n");
        document.head.appendChild(fontStyle);

        // 나머지 CSS + 본문은 Shadow DOM 에 넣어 사이트 스타일과 섞이지 않게
        const shadowCss = css.replace(/@font-face\s*\{[^}]*\}/g, "")
          .replace(/\bbody\s*\{/, ":host{display:block;")
          .replace(/\bhtml\s*\{/, ":host{");
        const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        root.innerHTML = "";
        const style = document.createElement("style");
        style.textContent = shadowCss;
        const main = document.importNode(srcMain, true) as HTMLElement;
        root.append(style, main);

        const ld = doc.querySelector('script[type="application/ld+json"]')?.textContent;
        if (ld && onJsonLd) {
          const parsed = JSON.parse(ld);
          const product = (parsed["@graph"] || [parsed]).find((n: { "@type"?: string }) => n["@type"] === "Product");
          if (product) onJsonLd(product);
        }

        const faces = fontFaces.map(f => [f.match(/font-family:\s*'([^']+)'/)?.[1], f.match(/font-weight:\s*(\d+)/)?.[1] || "400"]);
        await Promise.all(faces.map(([fam, w]) => fam ? document.fonts.load(`${w} 16px '${fam}'`, main.textContent || undefined).catch(() => []) : []));
        await Promise.all([...main.querySelectorAll("img")].map(i => i.decode().catch(() => {})));
        if (cancelled) return;
        applySizes(main, roles);
        let lastWidth = main.clientWidth;
        observer = new ResizeObserver(() => {
          if (main.clientWidth === lastWidth) return;
          lastWidth = main.clientWidth;
          applySizes(main, roles);
        });
        observer.observe(host);
      } catch (e) {
        console.error("[GeoDetail]", productId, e);
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      fontStyle?.remove();
    };
  }, [productId, onJsonLd]);

  if (failed) return <>{fallback}</>;
  return <div ref={hostRef} className="-mx-4 sm:mx-0" />;
}
