/**
 * 구성품 상세 → 세트 안내 (#306)
 * 매핑·문구 규칙은 config/setUpsell.ts. 세트가 품절·미공개면 아무것도 그리지 않는다.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Package } from "lucide-react";
import {
  fetchAutomaticDiscountData,
  discountPercentForProduct,
  fetchProductByHandle,
  formatPrice,
  ShopifyProduct,
} from "@/lib/shopify";
import { SET_UPSELL_BY_PRODUCT, setSavings, SetUpsellDef } from "@/config/setUpsell";
import { track } from "@/lib/track";

type SetCard = {
  def: SetUpsellDef;
  product: ShopifyProduct["node"];
  price: number;
  currency: string;
  /** 자동 할인 반영가 */
  salePrice: number;
  savings: number;
};

export function SetUpsellNote({ productId }: { productId: string }) {
  const numericId = productId.split("/").pop() ?? "";
  const defs = SET_UPSELL_BY_PRODUCT[numericId];
  const [cards, setCards] = useState<SetCard[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    setCards([]);
    if (!defs?.length) return;
    let alive = true;
    Promise.all([
      fetchAutomaticDiscountData(),
      Promise.all(defs.map((d) => fetchProductByHandle(d.handle).catch(() => null))),
    ])
      .then(([discounts, products]) => {
        if (!alive) return;
        const out: SetCard[] = [];
        products.forEach((p, i) => {
          if (!p || !p.variants.edges.some((e) => e.node.availableForSale)) return;
          const min = p.priceRange.minVariantPrice;
          const price = parseFloat(min.amount);
          const pct = discountPercentForProduct(discounts, p.id);
          out.push({
            def: defs[i],
            product: p,
            price,
            currency: min.currencyCode,
            salePrice: pct > 0 ? price - Math.round((price * pct) / 100) : price, // 상세 가격과 같은 반올림
            savings: setSavings(defs[i].listPrice, price, pct),
          });
        });
        setCards(out);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [numericId, defs]);

  if (!cards.length) return null;

  return (
    <div className="mt-4 space-y-2">
      {cards.map((c) => {
        const setId = c.product.id.split("/").pop();
        const img = c.product.images.edges[0]?.node;
        const go = () => {
          track("set_upsell_click", { from_product_id: numericId, set_product_id: setId, savings: c.savings });
          navigate(`/product/${setId}`);
        };
        return (
          <button
            key={c.def.handle}
            type="button"
            onClick={go}
            className="w-full flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-left hover:bg-amber-100 transition-colors"
          >
            {img ? (
              <img src={img.url} alt={img.altText ?? c.product.title} className="h-14 w-14 shrink-0 rounded-lg object-cover bg-white" />
            ) : (
              <div className="h-14 w-14 shrink-0 rounded-lg bg-white flex items-center justify-center">
                <Package className="h-6 w-6 text-amber-500" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-amber-700">
                {c.savings > 0 ? `セットなら¥${c.savings.toLocaleString("ja-JP")}お得` : "セットもあります"}
              </p>
              <p className="text-sm font-medium text-foreground line-clamp-2">{c.product.title}</p>
              <p className="text-sm" translate="no">
                {c.salePrice < c.price ? (
                  <>
                    <span className="font-bold text-red-500">{formatPrice(String(c.salePrice), c.currency)}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground line-through">{formatPrice(String(c.price), c.currency)}</span>
                  </>
                ) : (
                  <span className="font-bold">{formatPrice(String(c.price), c.currency)}</span>
                )}
              </p>
            </div>
            <span className="shrink-0 inline-flex items-center text-xs font-medium text-amber-700">
              セットを見る
              <ChevronRight className="h-4 w-4" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
