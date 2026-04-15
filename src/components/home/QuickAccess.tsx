import { useTranslation } from "@/hooks/useTranslation";

interface QuickAccessItem {
  icon: string;
  labelKey: string;
  badge?: string;
}

const quickAccessItems: QuickAccessItem[][] = [
  [
    { icon: "🎁", labelKey: "quickAccess.new" },
    { icon: "⏰", labelKey: "quickAccess.flashSale", badge: "HOT" },
    { icon: "🔥", labelKey: "quickAccess.clearance", badge: "-50%" },
    { icon: "🐕", labelKey: "quickAccess.dogs" },
    { icon: "🐱", labelKey: "quickAccess.cats" },
  ],
  [
    { icon: "🦴", labelKey: "quickAccess.treats" },
    { icon: "🥩", labelKey: "quickAccess.food" },
    { icon: "🧸", labelKey: "quickAccess.toys" },
    { icon: "⭐", labelKey: "quickAccess.topRated" },
    { icon: "💊", labelKey: "quickAccess.health" },
  ],
];

export function QuickAccess() {
  const { t } = useTranslation();

  return (
    <div className="mt-6 px-4 animate-fade-up" style={{ animationDelay: "0.1s" }}>
      <div className="grid grid-cols-5 gap-2">
        {quickAccessItems[0].map((item, index) => (
          <QuickAccessButton key={index} item={item} t={t} />
        ))}
      </div>
      <div className="grid grid-cols-5 gap-2 mt-3">
        {quickAccessItems[1].map((item, index) => (
          <QuickAccessButton key={index} item={item} t={t} />
        ))}
      </div>
    </div>
  );
}

function QuickAccessButton({ item, t }: { item: QuickAccessItem; t: (key: string) => string }) {
  return (
    <button className="flex flex-col items-center gap-1.5 group">
      <div className="relative w-12 h-12 bg-secondary rounded-2xl flex items-center justify-center text-xl shadow-sm group-hover:shadow-md group-hover:scale-105 transition-all duration-200">
        {item.icon}
        {item.badge && (
          <span className="absolute -top-1.5 -right-1 bg-primary text-primary-foreground text-[9px] font-bold px-1 py-0.5 rounded-full whitespace-nowrap">
            {item.badge}
          </span>
        )}
      </div>
      <span className="text-[11px] text-muted-foreground font-medium group-hover:text-foreground transition-colors text-center leading-tight">
        {t(item.labelKey)}
      </span>
    </button>
  );
}
