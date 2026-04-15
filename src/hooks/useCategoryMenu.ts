import { useState, useEffect } from 'react';
import { fetchMenu, fetchCollections, ShopifyMenu, ShopifyCollection } from '@/lib/shopify';

export interface CategoryMenuResult {
  menu: ShopifyMenu | null;
  collections: ShopifyCollection[];
}

// Module-level cache — shared across all instances, survives re-renders
let cached: CategoryMenuResult | null = null;
let pending: Promise<CategoryMenuResult> | null = null;

async function load(): Promise<CategoryMenuResult> {
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    try {
      const menu = await fetchMenu('customer-account-main-menu');
      if (menu && menu.items.length > 0) return { menu, collections: [] };

      const fallback = await fetchMenu('main-menu');
      if (fallback && fallback.items.length > 0) return { menu: fallback, collections: [] };

      const collections = await fetchCollections(20);
      return { menu: null, collections };
    } catch {
      return { menu: null, collections: [] };
    }
  })();

  cached = await pending;
  return cached;
}

export function useCategoryMenu(): CategoryMenuResult {
  const [result, setResult] = useState<CategoryMenuResult>(
    cached ?? { menu: null, collections: [] }
  );

  useEffect(() => {
    if (cached) return;
    load().then(setResult);
  }, []);

  return result;
}
