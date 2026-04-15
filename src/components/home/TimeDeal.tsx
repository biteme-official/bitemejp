import { ChevronRight, Clock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "@/hooks/useTranslation";

interface TimeDealProduct {
  id: number;
  image: string;
  title: string;
  originalPrice: number;
  salePrice: number;
  discount: number;
  soldPercentage: number;
}

const timeDealProducts: TimeDealProduct[] = [
  {
    id: 1,
    image: "🥩",
    title: "Premium Beef Jerky Treats 100g",
    originalPrice: 14.99,
    salePrice: 9.99,
    discount: 34,
    soldPercentage: 78,
  },
  {
    id: 2,
    image: "🍗",
    title: "Chicken Breast Jerky Value Pack",
    originalPrice: 19.99,
    salePrice: 13.99,
    discount: 30,
    soldPercentage: 45,
  },
];

export function TimeDeal() {
  const { t } = useTranslation();

  return (
    <section className="mt-6 animate-fade-up" style={{ animationDelay: "0.2s" }}>
      <div className="flex items-center justify-between px-4 mb-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <h2 className="text-base font-bold text-foreground">{t('timeDeal.todaysDeals')}</h2>
        </div>
        <button className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          {t('timeDeal.viewAll')}
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-3 px-4 overflow-x-auto pb-2 scrollbar-hide">
        {timeDealProducts.map((product) => (
          <TimeDealCard key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}

function TimeDealCard({ product }: { product: TimeDealProduct }) {
  const navigate = useNavigate();
  const { t, formatPrice } = useTranslation();

  return (
    <div 
      onClick={() => navigate(`/product/${product.id}`)}
      className="flex-shrink-0 w-40 bg-card rounded-xl border border-border overflow-hidden shadow-sm hover:shadow-card transition-shadow cursor-pointer"
    >
      <div className="aspect-square bg-secondary flex items-center justify-center text-5xl relative">
        {product.image}
        <span className="absolute top-2 left-2 bg-destructive text-destructive-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-md">
          -{product.discount}%
        </span>
      </div>
      <div className="p-3">
        <h3 className="text-xs font-medium text-foreground line-clamp-2 mb-2 min-h-[32px]">
          {product.title}
        </h3>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] text-muted-foreground line-through">
            {formatPrice(product.originalPrice)}
          </span>
          <span className="text-sm font-bold text-primary">
            {formatPrice(product.salePrice)}
          </span>
        </div>
        {/* Progress bar */}
        <div className="mt-2">
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${product.soldPercentage}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {product.soldPercentage}% {t('timeDeal.claimed')}
          </p>
        </div>
      </div>
    </div>
  );
}
