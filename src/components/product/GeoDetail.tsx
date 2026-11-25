import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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
  "10276704944441", // 携帯用折りたたみボウル パステル（4カラー）
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
  "10257263067449", // オールデイ クーリングマット（3サイズ）
  "10257261134137", // オールデイ クーリングピロー
  "10150720733497", // アクアベアライフベスト
  "10319683486009", // バナナ ノーズワークおもちゃ
  "10239663112505", // くまキャンディーボールおもちゃ (3個セット)
  "10294531686713", // ビションプーバックポーチ
  "10215547666745", // ぶんぶんリス浮き輪
  "10150722404665", // バディフォーク
  "10150724075833", // ブリトーノーズワークおもちゃ
  "10278691176761", // キャベツくんくんボールおもちゃ
  "10150719521081", // キャッチミー タグ 釣り竿おもちゃ（かわいい鳥のお友だち）
  "10150720667961", // キャッチミー タグ 釣り竿おもちゃ
  "10150722699577", // カラーポッププーバック マナー袋120枚（15枚×8ロール）
  "15409709351225", // ダブルヒートダウン v4
  "10278489162041", // ジェリーベアウープスクリップ
  "10150719127865", // ぴょんぴょんボールおもちゃ
  "10239670583609", // ミニスポーツボールおもちゃセット（３個入り）
  "10213360501049", // フレッシュ ベビーキャベツ ノーズワークトイ
  "10150723715385", // ミニテニスボールおもちゃ（3個入り）
  "15384010424633", // ノンスリップ排便マット グレー大型
  "15384010228025", // ノンスリップ排便マット グレー標準型
  "10319749513529", // オーマイプー マナー袋 120枚入
  "10318369456441", // ポケットポップフォルダブルメッシュバッグ（Mサイズ）
  "10270117986617", // ロールアップノーズワークトイ
  "10150722502969", // ランラン ラトルトイ
  "10150722470201", // 海のお友だちおもちゃ
  "10319683354937", // スリッパロープおもちゃ
  "10150723387705", // 小さなお友だち おもちゃ
  "10288985178425", // ヨーグルトトリオラテックスおもちゃ
  "10318369653049", // ポケットポップフォルダブルメッシュバッグ（Lサイズ）
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
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Shadow DOM 안 사이트 상품 링크(/product/...)는 새로고침 없이 앱 안에서 이동
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.composedPath()[0] as Element | undefined)?.closest?.("a");
      const href = a?.getAttribute("href");
      if (!a || !href || (a.target && a.target !== "_self")) return;
      if (href.startsWith("/") && !href.startsWith("//")) {
        e.preventDefault();
        navigateRef.current(href);
        window.scrollTo(0, 0);
      }
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [failed]);

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
        // 업체 형식 3가지: #bm-detail / .xdetail 로 감싼 본문 / body 바로 아래 본문(스타일이 body·html 기준)
        let src = doc.getElementById("bm-detail") ?? doc.querySelector<HTMLElement>(".xdetail");
        const bodyOnly = !src;
        if (bodyOnly) {
          if (!doc.body.querySelector("main")) throw new Error("bad geo html");
          src = doc.createElement("div");
          src.className = "geo-body";
          src.append(...doc.body.childNodes);
        }
        if (cancelled) return;

        // 글꼴: 이 상품 전용 이름으로 바꿔 문서에 등록(Shadow DOM 안의 @font-face 는 적용 안 됨)
        let css = [...doc.querySelectorAll("style")].map(s => s.textContent || "").join("\n");
        if (bodyOnly) css = css.replace(/(^|[}\s])(html|body)\s*\{/g, "$1.geo-body{");
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
