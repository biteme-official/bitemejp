import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { track } from "@/lib/track";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { HeroBanner } from "@/components/home/HeroBanner";
import { AffiliatePromo } from "@/components/home/AffiliatePromo";
import { NewProducts } from "@/components/home/NewProducts";
import { CategoryCircles } from "@/components/home/CategoryCircles";
import { CategorySections } from "@/components/home/CategorySections";
import { FeaturedProducts } from "@/components/home/FeaturedProducts";
import { InstagramReels } from "@/components/home/InstagramReels";
import { ProductGrid } from "@/components/shop/ProductGrid";
import { CategoryNav } from "@/components/shop/CategoryNav";
import { SortOption } from "@/components/shop/ProductFilters";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { BF_APPLY_END } from "@/lib/bfCoupon";
import { BF_SET_HANDLES, WINTER_COLLECTION_HANDLE, WINTER_HANDLES } from "@/config/homeFeatures";

// 구 핸들(일본어 포함) → 신 핸들(ASCII) 매핑
const HANDLE_ALIASES: Record<string, string> = {
  "bite-me-チェゴシム": "bite-me-chegosim",
};

const Index = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawCollection = searchParams.get("collection");
  const selectedCollection = rawCollection ? (HANDLE_ALIASES[rawCollection] ?? rawCollection) : null;

  useEffect(() => {
    if (rawCollection && HANDLE_ALIASES[rawCollection]) {
      setSearchParams(
        { collection: HANDLE_ALIASES[rawCollection] },
        { replace: true }
      );
    }
  }, [rawCollection]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    track('page_view', { title: 'メイン' });
  }, []);
  const searchQuery = searchParams.get("q") || "";
  const sortParam = searchParams.get("sort") as SortOption | null;
  useScrollRestoration();

  const isFiltered = !!(selectedCollection || searchQuery || sortParam);

  const handleSearch = (query: string) => {
    if (query) {
      setSearchParams({ q: query });
    } else {
      setSearchParams({});
    }
  };

  const handleCollectionSelect = (handle: string | null) => {
    if (handle) {
      setSearchParams({ collection: handle });
    } else {
      setSearchParams({});
    }
  };

  return (
    <div className="bg-background min-h-screen overflow-x-hidden overflow-y-auto">
      <Header onSearch={handleSearch} onCollectionSelect={handleCollectionSelect} />
      <CategoryNav selectedCollection={selectedCollection} onSelect={handleCollectionSelect} />
      {!isFiltered && (
        <div className="max-w-7xl mx-auto">
          <HeroBanner />
          <CategoryCircles />
          <AffiliatePromo />
          {Date.now() <= BF_APPLY_END && (
            <FeaturedProducts
              title="BLACK FRIDAY 限定セット"
              handles={BF_SET_HANDLES}
              badge={{ label: "SALE" }}
              moreLabel="セール詳細"
              moreTo="/black-friday"
              trackName="bf_sets_home"
            />
          )}
          <NewProducts />
          <FeaturedProducts
            title="冬・クリスマス特集"
            handles={WINTER_HANDLES}
            badge={{ label: "WINTER", className: "bg-sky-500 text-white" }}
            availableOnly
            moreLabel="もっと見る"
            moreTo={`/?collection=${encodeURIComponent(WINTER_COLLECTION_HANDLE)}`}
            trackName="winter_home"
          />
          <CategorySections />
          <InstagramReels />
        </div>
      )}
      <main id="product-grid" className="max-w-7xl mx-auto pb-20">
        <ProductGrid searchQuery={searchQuery} collectionHandle={selectedCollection} initialSort={sortParam ?? undefined} />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
