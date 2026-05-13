import { create } from 'zustand';

interface DiscountStore {
  productDiscounts: Record<string, number>; // productId → discount %
  variantDiscounts: Record<string, number>; // variantId → discount amount (¥)
  setProductDiscounts: (map: Record<string, number>) => void;
  setVariantDiscounts: (map: Record<string, number>) => void;
}

export const useDiscountStore = create<DiscountStore>((set) => ({
  productDiscounts: {},
  variantDiscounts: {},
  setProductDiscounts: (map) =>
    set((state) => ({ productDiscounts: { ...state.productDiscounts, ...map } })),
  setVariantDiscounts: (map) =>
    set((state) => ({ variantDiscounts: { ...state.variantDiscounts, ...map } })),
}));
