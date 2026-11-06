/**
 * /black-friday — 블랙프라이데이 2026 행사 안내 페이지
 *
 * 혜택·기간·유의사항을 한 화면에 모은다. 메인 배너·LINE 발송·인스타 링크의 도착지.
 *
 * - 기간은 lib/bfCoupon 값을 그대로 쓴다. 연장하면 거기(와 Shopify 할인 종료일)만 바꾼다.
 * - 한정 세트는 Shopify 컬렉션 BF_SET_COLLECTION 을 읽는다. 컬렉션이 없거나 공개된 상품이
 *   없으면 그 구역만 숨기므로, 세트가 늦어도 페이지는 먼저 열 수 있다.
 * - 15% 대상 외인 SSFW 는 인기 상품에서 뺀다(할인 페이지에 정가 상품이 섞이지 않도록).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { ProductCarousel, ProductCarouselSkeleton } from "@/components/home/ProductCarousel";
import { fetchBestSellingProducts, fetchCollectionProducts, fetchProductDiscounts, ShopifyProduct } from "@/lib/shopify";
import { BF_APPLY_END, BF_APPLY_START, BF_PERCENT } from "@/lib/bfCoupon";
import { FREE_SHIP_THRESHOLD } from "@/config/freeShipConfig";
import { isHiddenSoldOut } from "@/lib/productStock";
import { useDiscountStore } from "@/stores/discountStore";
import { track } from "@/lib/track";
import bfTitle from "@/assets/bf-title.png";
import bfPaper from "@/assets/bf-paper.jpg";

/** 한정 세트 컬렉션 핸들 — Shopify 에서 이 핸들로 만들면 자동으로 나온다 */
const BF_SET_COLLECTION = "bf-sets";
const ALL_PRODUCTS_LINK = "/?sort=best_selling";
const LIME = "#ACEB2A";

const isSsfw = (p: ShopifyProduct) => /SSFW/i.test(p.node.title);

function Benefit({ no, title, big, unit, children }: {
  no: string;
  title: string;
  big: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col rounded-2xl border border-white/15 bg-white/[0.04] p-5 md:p-6">
      <p className="text-xs font-bold tracking-widest" style={{ color: LIME }}>BENEFIT {no}</p>
      <p className="mt-2 text-sm font-bold text-white">{title}</p>
      <p className="mt-1 font-black leading-none" style={{ color: LIME }}>
        <span className="text-[2.75rem] md:text-5xl">{big}</span>
        {unit && <span className="ml-1 text-2xl md:text-3xl">{unit}</span>}
      </p>
      <div className="mt-3 flex-1 flex flex-col text-sm leading-relaxed text-white/75">{children}</div>
    </li>
  );
}

export default function BlackFriday() {
  const [sets, setSets] = useState<ShopifyProduct[]>([]);
  const [popular, setPopular] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const { productDiscounts: discountMap, setProductDiscounts } = useDiscountStore();

  const now = Date.now();
  const ended = now > BF_APPLY_END;
  const notStarted = now < BF_APPLY_START;

  useEffect(() => {
    document.title = "BLACK FRIDAY | バイトミー (BITEME) JAPAN";
    track("page_view", { title: "BLACK FRIDAY" });
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchCollectionProducts(BF_SET_COLLECTION, 12).then((r) => r.products).catch(() => [] as ShopifyProduct[]),
      fetchBestSellingProducts(16).catch(() => [] as ShopifyProduct[]),
    ])
      .then(([setResult, popularResult]) => {
        if (!alive) return;
        const setList = setResult.filter((p) => !isHiddenSoldOut(p));
        const setIds = new Set(setList.map((p) => p.node.id));
        const popularList = popularResult
          .filter((p) => !isHiddenSoldOut(p) && !isSsfw(p) && !setIds.has(p.node.id))
          .slice(0, 8);
        setSets(setList);
        setPopular(popularList);

        const reps: { productId: string; variantId: string }[] = [];
        [...setList, ...popularList].forEach((p) => {
          const v = (p.node.variants.edges.find((e) => e.node.availableForSale) ?? p.node.variants.edges[0])?.node;
          if (v) reps.push({ productId: p.node.id, variantId: v.id });
        });
        fetchProductDiscounts(reps)
          .then((map) => {
            if (alive && Object.keys(map).length > 0) setProductDiscounts(map);
          })
          .catch(console.error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [setProductDiscounts]);

  return (
    <div className="bg-background min-h-screen overflow-x-hidden">
      <Header />

      <div className="bg-[#0E0E0E] bg-cover bg-center" style={{ backgroundImage: `url(${bfPaper})` }}>
        <section className="max-w-3xl mx-auto px-5 pt-10 pb-8 md:pt-14 md:pb-10 text-center">
          <p
            className="mx-auto max-w-md border-y py-2 text-sm md:text-base font-bold tracking-[0.3em]"
            style={{ color: LIME, borderColor: LIME }}
          >
            年に一度のビッグセール
          </p>
          <h1 className="mt-5">
            <img src={bfTitle} alt="BITE ME BLACK FRIDAY" width={760} height={292} className="mx-auto w-full max-w-md md:max-w-xl h-auto" />
          </h1>
          <p
            className="mt-6 inline-block rounded-full px-6 py-2.5 text-base md:text-xl font-bold text-[#0E0E0E]"
            style={{ backgroundColor: LIME }}
          >
            11/9(月) 10:00 〜 11/22(日) 23:59
          </p>
          {notStarted && <p className="mt-3 text-sm text-white/75">日本時間 11/9(月) 10:00 スタート</p>}
          {ended && <p className="mt-3 text-sm font-bold text-white">このセールは終了しました。ご利用ありがとうございました。</p>}
        </section>

        {!ended && (
          <section className="max-w-5xl mx-auto px-5 pb-10 md:pb-14">
            <ul className="grid gap-3 md:grid-cols-3 md:gap-4">
              <Benefit no="01" title="どなたでも対象商品が" big="15" unit="%OFF">
                <p>カートで自動的に割引されます。クーポンの入力は不要です。</p>
              </Benefit>
              <Benefit no="02" title="LINE友だちは さらに" big={String(BF_PERCENT)} unit="%OFF">
                <p>事前にクーポンを受け取ると、お支払い時に自動で適用されます。</p>
                <Link
                  to="/bf"
                  onClick={() => track("bf_page_coupon_click")}
                  className="mt-4 inline-flex items-center justify-center gap-1 rounded-full px-4 py-2.5 text-sm font-bold text-[#0E0E0E]"
                  style={{ backgroundColor: LIME }}
                >
                  クーポンを受け取る
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </Benefit>
              <Benefit no="03" title={`¥${FREE_SHIP_THRESHOLD.toLocaleString()}以上のお買い上げで`} big="送料無料">
                <p>条件を満たすと、お支払い時に送料が無料になります。</p>
              </Benefit>
            </ul>
          </section>
        )}
      </div>

      <main className="max-w-7xl mx-auto pt-8 md:pt-10">
        {loading ? (
          <ProductCarouselSkeleton />
        ) : (
          <>
            {sets.length > 0 && (
              <ProductCarousel
                title="限定セット"
                products={sets}
                discountMap={discountMap}
                trackName="bf_sets"
                trackSource="bf_sets"
                className="mb-6"
              />
            )}
            {popular.length > 0 && (
              <ProductCarousel
                title="人気商品"
                products={popular}
                discountMap={discountMap}
                trackName="bf_popular"
                trackSource="bf_popular"
              />
            )}
          </>
        )}

        <div className={`mt-4 px-5 text-center ${ended ? "mb-12" : ""}`}>
          <Link
            to={ALL_PRODUCTS_LINK}
            onClick={() => track("bf_page_all_click")}
            className="inline-flex items-center gap-1 rounded-full bg-[#0E0E0E] px-8 py-3.5 text-sm font-bold text-white"
          >
            すべての商品を見る
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>

        {!ended && (
          <section className="max-w-3xl mx-auto mt-10 mb-12 px-5">
            <h2 className="text-sm font-bold">ご注意事項</h2>
            <ul className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">
              <li>※SSFW商品は15%OFFの対象外です。</li>
              <li>※LINE友だち{BF_PERCENT}%OFFクーポンは、お一人さま1回限り。ご本人のアカウントでのみご利用いただけます。</li>
              <li>※初回クーポン(10%OFF)が未使用の方は、割引が大きい初回クーポンが優先して適用されます。</li>
              <li>※パートナー(アフィリエイト)の割引コードをお持ちの場合は、そちらが優先されます。</li>
              <li>※最終的な割引額はお支払い画面でご確認ください。</li>
            </ul>
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
}
