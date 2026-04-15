// GA4 Enhanced Ecommerce Event Tracking
// https://developers.google.com/analytics/devguides/collection/ga4/ecommerce

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag(...args);
  }
}

interface GA4Item {
  item_id: string;
  item_name: string;
  item_brand?: string;
  item_category?: string;
  item_variant?: string;
  price?: number;
  quantity?: number;
  currency?: string;
}

// view_item_list - when product list is displayed
export function trackViewItemList(
  items: GA4Item[],
  listName: string = 'Product Grid'
) {
  gtag('event', 'view_item_list', {
    item_list_name: listName,
    items: items.map((item, index) => ({
      ...item,
      index,
    })),
  });
}

// view_item - when a user views a product detail page
export function trackViewItem(item: GA4Item) {
  gtag('event', 'view_item', {
    currency: item.currency || 'USD',
    value: item.price || 0,
    items: [item],
  });
}

// add_to_cart
export function trackAddToCart(item: GA4Item) {
  gtag('event', 'add_to_cart', {
    currency: item.currency || 'USD',
    value: (item.price || 0) * (item.quantity || 1),
    items: [item],
  });
}

// remove_from_cart
export function trackRemoveFromCart(item: GA4Item) {
  gtag('event', 'remove_from_cart', {
    currency: item.currency || 'USD',
    value: (item.price || 0) * (item.quantity || 1),
    items: [item],
  });
}

// view_cart - when user opens the cart
export function trackViewCart(
  items: GA4Item[],
  currency: string,
  value: number
) {
  gtag('event', 'view_cart', {
    currency,
    value,
    items,
  });
}

// begin_checkout - when user clicks checkout
export function trackBeginCheckout(
  items: GA4Item[],
  currency: string,
  value: number,
  coupon?: string
) {
  gtag('event', 'begin_checkout', {
    currency,
    value,
    coupon,
    items,
  });
}

// purchase - when user returns from checkout
export function trackPurchase(
  transactionId: string,
  items: GA4Item[],
  currency: string,
  value: number,
  shipping?: number
) {
  gtag('event', 'purchase', {
    transaction_id: transactionId,
    currency,
    value,
    shipping,
    items,
  });
}

// Helper: convert Shopify product node to GA4 item
export function shopifyToGA4Item(
  product: {
    id: string;
    title: string;
    vendor?: string;
    productType?: string;
  },
  variant?: {
    title?: string;
    price?: { amount: string; currencyCode: string };
  },
  quantity?: number
): GA4Item {
  return {
    item_id: product.id,
    item_name: product.title,
    item_brand: product.vendor,
    item_category: product.productType,
    item_variant: variant?.title !== 'Default Title' ? variant?.title : undefined,
    price: variant?.price ? parseFloat(variant.price.amount) : undefined,
    currency: variant?.price?.currencyCode,
    quantity: quantity || 1,
  };
}
