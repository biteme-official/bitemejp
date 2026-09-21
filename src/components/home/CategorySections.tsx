import { useEffect, useState } from "react";
import {
  ShopifyCollection,
  ShopifyProduct,
  fetchCollectionProducts,
  fetchProductDiscounts,
} from "@/lib/shopify";
import { ProductBadge } from "./ProductCard";
import { ProductCarousel, ProductCarouselSkeleton } from "./ProductCarousel";

/** 메인에 노출할 컬렉션. 배지는 섹션 성격을 한 단어로 — 시안의 BEST/PICK 계열 */
const CATEGORY_WHITELIST: { handle: string; title: string; badge: ProductBadge }[] = [
  {
    handle: "小さなお口にもぴったり-ミニおもちゃ特集",
    title: "小さなお口にもぴったり！ミニおもちゃ特集",
    badge: { label: "PICK", className: "bg-sky-500 text-white" },
  },
  { handle: "人気商品", title: "人気商品", badge: { label: "BEST" } },
  {
    handle: "bite-me-choigosim",
    title: "BITE ME×チェゴシム",
    badge: { label: "COLLAB", className: "bg-pink-500 text-white" },
  },
];

interface CategoryData {
  collection: ShopifyCollection;
  products: ShopifyProduct[];
  badge: ProductBadge;
}

export function CategorySections() {
  const [sections, setSections] = useState<CategoryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [discountMap, setDiscountMap] = useState<Record<string, number>>({});

  useEffect(() => {
    const load = async () => {
      try {
        const results = await Promise.all(
          CATEGORY_WHITELIST.map(async ({ handle, title, badge }) => {
            const res = await fetchCollectionProducts(handle, 8);
            const collection: ShopifyCollection = { id: handle, title, handle, description: "", image: null };
            return { collection, products: res.products, badge };
          })
        );

        const validSections = results
          .map(({ collection, products, badge }) => ({
            collection,
            badge,
            products: products.filter(p =>
              p.node.variants.edges.some(e => e.node.availableForSale)
            ),
          }))
          .filter((r) => r.products.length >= 4);
        setSections(validSections);
        const reps: { productId: string; variantId: string }[] = [];
        const seen = new Set<string>();
        validSections.flatMap(r => r.products).forEach(p => {
          if (seen.has(p.node.id)) return;
          seen.add(p.node.id);
          const v = (p.node.variants.edges.find(e => e.node.availableForSale) ?? p.node.variants.edges[0])?.node;
          if (v) reps.push({ productId: p.node.id, variantId: v.id });
        });
        fetchProductDiscounts(reps).then(map => {
          if (Object.keys(map).length === 0) return;
          setDiscountMap(map);
        });
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="mt-8 space-y-6">
        <ProductCarouselSkeleton />
        <ProductCarouselSkeleton />
      </div>
    );
  }

  if (sections.length === 0) return null;

  return (
    <div className="mt-8 space-y-6">
      {sections.map(({ collection, products, badge }) => {
        const match = collection.handle.match(/-(\d+)-off/i);
        const collDiscountPct = match ? parseInt(match[1], 10) : 0;

        return (
          <ProductCarousel
            key={collection.id}
            title={collection.title}
            products={products}
            badge={badge}
            discountMap={discountMap}
            collectionDiscountPct={collDiscountPct}
            moreLabel="もっと見る"
            moreTo={`/?collection=${encodeURIComponent(collection.handle)}`}
            trackName={collection.handle}
          />
        );
      })}
    </div>
  );
}
