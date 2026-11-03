/**
 * 어필리에이트 상황별 메시지 — 종류 · 받는 사람 규칙 설명 · 다시 보내는 간격 · 기본 문구 · 변수 (Issue #272)
 *
 * 프로모션 센터 「메일 발송」의 메일 종류(lib/mailTemplates.ts)를 LINE 으로 옮긴 것.
 * 서버가 이 정의 하나로 받는 사람을 고르고 문구를 채운다. 어드민 화면은 GET 응답으로 이 정의를 받아 그린다 —
 * 화면과 서버가 같은 문장을 보게 하려고 화면 쪽에 사본을 두지 않는다.
 *
 * 본문은 일본어 평문. `{{変数}}` 는 받는 사람마다 채운다. 모르는 변수가 있으면 미리 보기·보내기가 막는다.
 */

export type MessageKind =
  | 'welcome'
  | 'first_share'
  | 'sales_tip'
  | 'first_sale'
  | 'monthly_report'
  | 'payout_payable'
  | 'payout_carried'
  | 'dormant'
  | 'custom';

/**
 * 같은 사람에게 다시 보내는 규칙
 *   once   — 한 번만 (가입 환영·첫 판매 축하)
 *   days   — 같은 상황을 N일 안에 받았으면 뺀다
 *   param  — 같은 대상 월·정산 월로는 한 번만 (월간 리포트·정산 안내)
 *   filter — 자유 공지: 화면에서 고른 「최근 N일 안에 받은 사람 제외」(상황 무관)
 */
export type GapRule = { type: 'once' } | { type: 'days'; days: number } | { type: 'param' } | { type: 'filter' };

/** 상황마다 화면에서 고르는 값 — 없으면 null */
export type ParamKind = 'filter' | 'month' | 'period' | null;

export interface KindDef {
  kind: MessageKind;
  group: string;
  label: string;
  /** 받는 사람 규칙 — 화면에 그대로 */
  audience: string;
  gap: GapRule;
  param: ParamKind;
  /** 이 상황에서 쓸 수 있는 변수 (공통 변수 포함) */
  variables: string[];
  defaultBody: string;
}

/** 모든 상황에서 쓰는 변수 */
export const COMMON_VARIABLES = ['名前', '紹介リンク', 'パートナーページ'] as const;

export const PARTNER_PAGE_URL = 'https://biteme.co.jp/partner';
const GUIDELINE_URL = 'https://biteme.co.jp/affiliate/terms#guideline';

/** 화면의 묶음 순서 */
export const KIND_GROUPS = ['시작', '성장', '정산', '안내·공지'] as const;

export const KIND_DEFS: KindDef[] = [
  {
    kind: 'welcome',
    group: '시작',
    label: '가입 환영',
    audience: '최근 7일 안에 가입한 사람 (한 번만)',
    gap: { type: 'once' },
    param: null,
    variables: [...COMMON_VARIABLES],
    defaultBody: `【BITE ME アフィリエイト】
{{名前}}さん、パートナー登録ありがとうございます！🎉

あなた専用の紹介リンクはこちら👇
{{紹介リンク}}

リンクからのご購入金額（送料除く）の10%が報酬になります。
※LINEでログインしたお客さまのご購入が対象です

▼はじめての方へ
・商品ページの「パートナー：コピー」で、商品ごとのリンクも作れます
・投稿には必ず「#PR」の表示をお願いします
広告表示ガイドライン：${GUIDELINE_URL}

成果はパートナーページでいつでも確認できます
{{パートナーページ}}`,
  },
  {
    kind: 'first_share',
    group: '시작',
    label: '첫 공유 유도',
    audience: '가입 7일 지남 · 최근 30일 클릭 0 · 판매 0 (14일 간격)',
    gap: { type: 'days', days: 14 },
    param: null,
    variables: [...COMMON_VARIABLES],
    defaultBody: `【BITE ME アフィリエイト】
{{名前}}さん、ご登録ありがとうございます！
紹介リンク、もうシェアしましたか？😊

▼かんたん3ステップ
① パートナーページで紹介リンクをコピー
② 商品ページの「パートナー：コピー」で、その商品に直接飛ぶリンクも作れます
③ インスタのストーリーズ・プロフィール・LINEでシェア

リンクからのご購入金額（送料除く）の10%が報酬になります。
※LINEでログインしたお客さまのご購入が対象です

※投稿には必ず「#PR」の表示をお願いします
広告表示ガイドライン：${GUIDELINE_URL}

▼あなたの紹介リンク
{{紹介リンク}}
▼パートナーページ
{{パートナーページ}}`,
  },
  {
    kind: 'sales_tip',
    group: '성장',
    label: '판매 팁',
    audience: '최근 30일 클릭 있음 · 판매 0 (14일 간격)',
    gap: { type: 'days', days: 14 },
    param: null,
    variables: [...COMMON_VARIABLES, 'クリック数'],
    defaultBody: `【BITE ME アフィリエイト】
{{名前}}さん、リンクのシェアありがとうございます！
この30日で {{クリック数}}回 クリックされています👏
ご購入につながりやすいコツをお届けします💡

① 商品ごとのリンクで紹介する（商品ページの「パートナー：コピー」）
② 実際に使っている写真や動画と一緒に投稿する
③ ストーリーズにはリンクスタンプを付ける

※購入されたお客さまがLINEでログインしていると報酬の対象になります
※投稿には「#PR」の表示をお願いします

▼あなたの紹介リンク
{{紹介リンク}}
▼パートナーページ
{{パートナーページ}}`,
  },
  {
    kind: 'first_sale',
    group: '성장',
    label: '첫 판매 축하',
    audience: '판매(확정 대기·확정)가 1건 이상인 사람 (한 번만)',
    gap: { type: 'once' },
    param: null,
    variables: [...COMMON_VARIABLES, '注文数', '報酬見込み'],
    defaultBody: `【BITE ME アフィリエイト】
{{名前}}さん、はじめての成果が生まれました！🎉
あなたのリンクからご購入がありました。

これまでの成果：{{注文数}}件・報酬見込み {{報酬見込み}}
※報酬はご注文から30日後に確定し、翌月末にお支払いします（¥3,000未満は翌月へ繰り越し）

この調子でシェアを続けてみてください！
{{パートナーページ}}`,
  },
  {
    kind: 'monthly_report',
    group: '성장',
    label: '월간 성과 리포트',
    audience: '고른 달에 클릭이나 주문이 있는 사람 (같은 달로 한 번만)',
    gap: { type: 'param' },
    param: 'month',
    variables: [...COMMON_VARIABLES, '対象月', 'クリック数', '注文数', '報酬見込み'],
    defaultBody: `【BITE ME アフィリエイト】{{対象月}}の成果レポート
{{名前}}さん、いつもありがとうございます。

・クリック：{{クリック数}}回
・ご注文：{{注文数}}件
・報酬見込み：{{報酬見込み}}

※報酬はご注文から30日後に確定します
詳しくはパートナーページで
{{パートナーページ}}`,
  },
  {
    kind: 'payout_payable',
    group: '정산',
    label: '지급 안내',
    audience: '고른 정산 월에 지급 대상(지급 예정·지급 완료)인 사람 (정산 월마다 한 번)',
    gap: { type: 'param' },
    param: 'period',
    variables: [...COMMON_VARIABLES, '対象月', '支払額', '支払予定日'],
    defaultBody: `【BITE ME アフィリエイト】{{対象月}}分 報酬のお支払いについて
{{名前}}さん、{{対象月}}分の報酬が確定しました。

お支払い額：{{支払額}}
お支払い予定日：{{支払予定日}}

お振込先については、担当者より別途ご連絡いたします。
{{パートナーページ}}`,
  },
  {
    kind: 'payout_carried',
    group: '정산',
    label: '이월 안내',
    audience: '고른 정산 월에 ¥3,000 미만이라 이월된 사람 (정산 월마다 한 번)',
    gap: { type: 'param' },
    param: 'period',
    variables: [...COMMON_VARIABLES, '対象月', '繰越額'],
    defaultBody: `【BITE ME アフィリエイト】{{対象月}}分 報酬のご案内
{{名前}}さん、{{対象月}}分の確定報酬は {{繰越額}} でした。

お支払いは¥3,000以上からのため、今回は翌月へ繰り越しとなります（規約第5条）。
繰り越した報酬はなくならず、合計が¥3,000に達した月にお支払いします。

{{パートナーページ}}`,
  },
  {
    kind: 'dormant',
    group: '안내·공지',
    label: '휴면 재활성',
    audience: '가입 60일 지남 · 최근 60일 클릭 0 (30일 간격)',
    gap: { type: 'days', days: 30 },
    param: null,
    variables: [...COMMON_VARIABLES],
    defaultBody: `【BITE ME アフィリエイト】
{{名前}}さん、お久しぶりです！BITE ME です。
新商品やセールも続々登場しています🐶🐱

紹介リンクはそのままお使いいただけます👇
{{紹介リンク}}

※投稿には「#PR」の表示をお願いします
{{パートナーページ}}`,
  },
  {
    kind: 'custom',
    group: '안내·공지',
    label: '자유 공지',
    audience: '화면에서 고른 조건 (클릭 0 · 판매 0 · 가입 N일 · 최근 N일 받은 사람 제외)',
    gap: { type: 'filter' },
    param: 'filter',
    variables: [...COMMON_VARIABLES],
    defaultBody: `【BITE ME アフィリエイト】
{{名前}}さん、こんにちは！BITE ME です。



{{パートナーページ}}`,
  },
];

export const kindDef = (kind: string): KindDef | undefined => KIND_DEFS.find((d) => d.kind === kind);

const VAR_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** 본문에 쓰였지만 이 상황에 없는 변수 */
export function unknownVariables(body: string, def: KindDef): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(VAR_RE)) if (!def.variables.includes(m[1])) out.add(m[1]);
  return [...out];
}

export function renderBody(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (whole, key: string) => (key in vars ? vars[key] : whole));
}

export const yenText = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;

/** 'YYYY-MM' → 「2026年10月」 */
export const monthText = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return `${y}年${m}月`;
};

/** 'YYYY-MM-DD' → 「2026年11月30日」 */
export const dateText = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${y}年${m}月${d}日`;
};
