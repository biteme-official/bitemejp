import { useSearchParams } from "react-router-dom";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { HeroBanner } from "@/components/home/HeroBanner";
import { PopularProducts } from "@/components/home/PopularProducts";
import { CategorySections } from "@/components/home/CategorySections";
import { InstagramReels } from "@/components/home/InstagramReels";
import { ProductGrid } from "@/components/shop/ProductGrid";
import { CategoryNav } from "@/components/shop/CategoryNav";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";

const Index = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCollection = searchParams.get("collection");
  const searchQuery = searchParams.get("q") || "";
  useScrollRestoration();

  const isFiltered = !!(selectedCollection || searchQuery);

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
          <PopularProducts />
          <CategorySections />
          <InstagramReels />
        </div>
      )}
      <main className="max-w-7xl mx-auto pb-20">
        <ProductGrid searchQuery={searchQuery} collectionHandle={selectedCollection} />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
