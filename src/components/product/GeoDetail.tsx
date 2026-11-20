import { useEffect, useRef, useState } from "react";

// GEO 상세페이지(업체 변환본: 이미지 + 글자 겹침, 글자 크기는 CSS cqw 로 고정). 원본 HTML은 public/geo/ja/{상품 숫자 ID}.html 에 둔다.
// 업체 파일의 한국 자사몰 링크는 넣을 때 사이트 상대 주소(/product/...)로 바꾼다.
// 목록에 없는 상품은 기존 Shopify 설명을 쓴다. (없는 파일도 SPA 폴백으로 200이 오므로 목록으로 판단)
export const GEO_DETAIL_IDS = new Set([
  "10346561569081", // おしっこ足跡防止 ゼロガードマット
  "10150719291705", // ジャンピングブギ ーノーズワーク プレイボール自動おもちゃ
  "10150718865721", // コンフォートハーネスv2
  "10150718800185", // コンフォートリード v2
  "15407342420281", // ポイントケア 三角スリッカー
  "10201780683065", // ジェリーベアLEDライト (3カラー)
  "10150721585465", // ヘイトミーバンド
  "10150721454393", // ベーキングデイ ノーズワークプレイブック
  "10213336547641", // リトルオーシャンフレンズトイ
  "10150722142521", // ブレイングトイ スピンアンドスナック リス
  "10150720307513", // イージーバイトグリップ
  "10150724534585", // 農場ノーズワークおもちゃ
  "10213414437177", // カラフル ミニトマト ラテックストイ
  "10150720635193", // 総合フルーツセット ノーズワークトイ
  "10202476052793", // ノーズワークプレイブック マイバースデー
  "10150719029561", // ブレイニングトイ スピンアンドスナック バニー
  "10276698849593", // ミニスナックボトル（4カラー）
  "10276704944441", // 携帯用折りたたみボウル　パステル（4カラー）
  "10150722961721", // ピーナッツ ラテックストイ(4個入り)
  "10150724239673", // ジェリーベアー ラウンド フェイスコーム
  "10150723649849", // ミニシリコンポット
  "10346592436537", // ノーズワーク プレイボール 自動おもちゃ カニカバー（※カバーのみ。自動プレイボール付属なし）
  "10202477592889", // ノーズワークプレイブック 洗濯の日
  "10202475561273", // ノーズワークプレイブック ランチボックス
  "10150723846457", // 農場のお友だちボールおもちゃ
  "10150721487161", // ヘイトミーパッチ（8シール×3枚＝24シール入り）
  "10150723911993", // グッドナイト ノーズワークプレイブック
  "10150723551545", // ゾウのくつ下おもちゃ
  "10150721880377", // 野菜畑ボールおもちゃ(2個セット)
  "10319794503993", // 靴下 おもちゃセット(3枚セット)
]);

type JsonLdProduct = Record<string, unknown>;

export interface GeoDetailProps {
  productId: string;
  onJsonLd?: (product: JsonLdProduct) => void;
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

    (async () => {
      try {
        const res = await fetch(`/geo/ja/${productId}.html`);
        if (!res.ok) throw new Error(String(res.status));
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const src = doc.getElementById("bm-detail");
        if (!src) throw new Error("bad geo html");
        if (cancelled) return;

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
        const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        root.innerHTML = "";
        const style = document.createElement("style");
        style.textContent = css.replace(/@font-face\s*\{[^}]*\}/g, "");
        const detail = document.importNode(src, true) as HTMLElement;
        detail.querySelectorAll("style").forEach(s => s.remove());
        root.append(style, detail);

        const ld = doc.querySelector('script[type="application/ld+json"]')?.textContent;
        if (ld && onJsonLd) {
          const parsed = JSON.parse(ld);
          const product = (parsed["@graph"] || [parsed]).find((n: { "@type"?: string }) => n["@type"] === "Product");
          if (product) onJsonLd(product);
        }
      } catch (e) {
        console.error("[GeoDetail]", productId, e);
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      fontStyle?.remove();
    };
  }, [productId, onJsonLd]);

  if (failed) return <>{fallback}</>;
  return <div ref={hostRef} className="-mx-4 sm:mx-0" />;
}
