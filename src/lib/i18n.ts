export type Language = 'ja';

export const translations: Record<string, Record<string, string | Record<string, string>>> = {
  common: {
    loading: '読み込み中...',
    error: 'エラー',
    success: '成功',
    cancel: 'キャンセル',
    confirm: '確認',
  },
  nav: {
    shop: 'ショップ',
    cart: 'カート',
    favorites: 'お気に入り',
    account: 'マイページ',
    searchProducts: '商品を検索...',
  },
  search: {
    recentSearches: '最近の検索',
    suggestions: 'おすすめ商品',
    noResults: '結果が見つかりません',
  },
  header: {
    login: 'ログイン',
    logout: 'ログアウト',
    signup: '新規登録',
  },
  languages: {
    ja: '日本語',
  },
  cart: {
    title: 'ショッピングカート',
    empty: 'カートは空です',
    itemCount: '点の商品',
    total: '合計',
    checkout: 'レジに進む',
    creatingCheckout: 'チェックアウト準備中...',
    addedToCart: 'カートに追加しました',
    awayFrom: 'あと',
    unlockedAll: '🎉 すべての特典を獲得しました！',
    freeShipping: '送料無料',
    discount5: '5%オフ',
    freeGift: '無料ギフト',
    shippingCost: '送料',
    currentShipping: '現在の送料',
  },
  checkout: {
    returnTitle: '注文完了',
    thankYou: 'ありがとうございます！',
    orderConfirmation: 'ご注文が完了しました。確認メールをご確認ください。',
    trackingInfo: '配送追跡',
    trackingDesc: '発送後、追跡番号をメールでお送りします。',
    continueShopping: 'ショッピングを続ける',
    viewOrders: '注文履歴を見る',
    inAppNotice: 'アプリに戻るには、上部の戻るボタンまたは X をタップしてください。',
    orderNumber: '注文番号',
  },
  product: {
    addToCart: 'カートに追加',
    noProducts: '商品が見つかりません',
    soldOut: '売り切れ',
    selectOption: 'オプションを選択',
    loadMore: 'もっと見る',
    quantity: '数量',
    outOfStock: '在庫切れ',
    back: '戻る',
    notFound: '商品が見つかりません',
    total: '合計',
    shippingBenefit: '送料¥400〜¥500',
    shippingBenefitDesc: '配送エリアによって異なります',
    qualityGuarantee: '品質保証',
    qualityGuaranteeDesc: '100%満足保証',
    easyReturns: '簡単返品',
    easyReturnsDesc: '30日以内',
    aboutProduct: 'この商品について',
    someSizesUnavailable: '一部サイズ在庫なし',
    addedToCart: 'カートに追加しました',
  },
  filters: {
    sort: '並び替え',
    sortOptions: {
      default: 'デフォルト',
      priceAsc: '価格: 安い順',
      priceDesc: '価格: 高い順',
      titleAsc: '名前: あ-ん',
      titleDesc: '名前: ん-あ',
    },
    filter: 'フィルター',
    reset: 'リセット',
    priceRange: '価格帯',
    availability: '在庫状況',
    all: 'すべて',
    available: '在庫あり',
    apply: 'フィルターを適用',
    clearFilters: 'フィルターをクリア',
  },
  quickAccess: {
    new: '新着',
    flashSale: 'タイムセール',
    clearance: 'クリアランス',
    dogs: '犬',
    cats: '猫',
    treats: 'おやつ',
    food: 'フード',
    toys: 'おもちゃ',
    topRated: '人気',
    health: '健康',
  },
  timeDeal: {
    todaysDeals: '本日のセール',
    viewAll: 'すべて見る',
    claimed: '売れた',
  },
};

export function getLanguage(): Language {
  return 'ja';
}

export function getLocale(): string {
  return 'ja-JP';
}

export function t(path: string): string {
  const keys = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any = translations;

  for (const key of keys) {
    if (result && typeof result === 'object' && key in result) {
      result = result[key];
    } else {
      return path;
    }
  }

  if (typeof result === 'string') {
    return result;
  }

  return path;
}
