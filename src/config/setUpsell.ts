/**
 * 구성품 상세 → 세트 안내 (「セットでお得」)
 *
 * 블프 첫 사흘(11/9~11/11) 주문 152건 중 세트는 0개인데, 세트 구성품을 하나씩 따로 전부 담은 주문이 36건이었다.
 * 조합 수요는 있는데 세트를 못 보고 지나간 것 — 구성품 상세에서 세트를 보여 준다.
 *
 * - 키 = 구성품 상품 번호(Shopify numeric id), 값 = 세트 핸들(BF_SET_HANDLES 중).
 * - listPrice = 구성품 정가 합계(세트 세팅 요청 시트 기준). 세트 판매가가 이보다 낮을 때만 「お得」 금액을 쓴다.
 *   같으면 금액 없이 「セットもあります」 — 할인이 없는데 お得 라고 쓰면 안 된다.
 * - 세트가 품절·미공개면 안내를 숨긴다(Storefront 가 돌려주지 않거나 availableForSale=false).
 */

export interface SetUpsellDef {
  handle: string;
  /** 카드에 쓸 짧은 이름 — 없으면 세트 상품명. 상품명이 길어 모바일에서 4줄이 되는 세트만 */
  label?: string;
  /** 구성품 정가 합계(엔) */
  listPrice: number;
}

const TOILET_L: SetUpsellDef = { handle: "コンプリートトイレセット-ゼロガードマット-ノンスリップ排便マット-1", label: "コンプリートトイレセット（大型）", listPrice: 8980 };
const TOILET_S: SetUpsellDef = { handle: "コンプリートトイレセット-ゼロガードマット-ノンスリップ排便マット-標準", label: "コンプリートトイレセット（標準）", listPrice: 7279 };
const HARNESS: SetUpsellDef = { handle: "コンフォートハーネス-リードセット", listPrice: 6960 };
const SLICKER: SetUpsellDef = { handle: "三角スリッカー-ジェリーベアーフェイスコームセット", listPrice: 2770 };
const BIRTHDAY: SetUpsellDef = { handle: "バースデーギフトセット-ケーキハット-ノーズワークプレイブック", listPrice: 4194 };
const WALK: SetUpsellDef = { handle: "お散歩セット-ジェリーベアledライト-メッセージワッペン", listPrice: 2896 };
const BOTTLE: SetUpsellDef = { handle: "ミニスナックボトル-折りたたみボウルセット", listPrice: 1618 };
const LATEX: SetUpsellDef = { handle: "ひと口でくわえやすいラテックストイ3点セット", listPrice: 4250 };

/** 구성품 상품 번호 → 그 구성품이 들어간 세트(여럿이면 위에서부터 보여 준다) */
export const SET_UPSELL_BY_PRODUCT: Record<string, SetUpsellDef[]> = {
  "10346561569081": [TOILET_S, TOILET_L], // おしっこ足跡防止 ゼロガードマット
  "15384010228025": [TOILET_S], // ノンスリップ排便マット グレー標準型
  "15384010424633": [TOILET_L], // ノンスリップ排便マット グレー大型
  "10150718865721": [HARNESS], // コンフォートハーネスv2
  "10150718800185": [HARNESS], // コンフォートリード v2
  "15407342420281": [SLICKER], // ポイントケア 三角スリッカー
  "10150724239673": [SLICKER], // ジェリーベアー ラウンド フェイスコーム
  "10319803416889": [BIRTHDAY], // バースデーケーキハットおもちゃ
  "10202476052793": [BIRTHDAY], // ノーズワークプレイブック マイバースデー
  "10201780683065": [WALK], // ジェリーベアLEDライト
  "10150721028409": [WALK], // お散歩メッセージワッペン
  "10276698849593": [BOTTLE], // ミニスナックボトル
  "10276704944441": [BOTTLE], // 携帯用折りたたみボウル パステル
  "10213414437177": [LATEX], // カラフル ミニトマト ラテックストイ
  "10150722961721": [LATEX], // ピーナッツ ラテックストイ(4個入り)
  "10288985178425": [LATEX], // ヨーグルトトリオラテックスおもちゃ
};

/**
 * 세트로 사면 아끼는 금액(엔). 자동 할인(블프 15% 등)은 세트·단품에 똑같이 붙으므로 같은 비율로 줄여 준다.
 * 0 이하면 0 — 「お得」 문구를 쓰지 않는다.
 */
export function setSavings(listPrice: number, setPrice: number, discountPct: number): number {
  const diff = listPrice - setPrice;
  if (diff <= 0) return 0;
  return Math.floor(diff * (1 - discountPct / 100));
}
