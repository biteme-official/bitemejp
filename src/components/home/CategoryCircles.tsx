import {
  Apple,
  Bone,
  Cat,
  Footprints,
  LayoutGrid,
  LucideIcon,
  PawPrint,
  Shirt,
  Sofa,
  Sparkles,
  UtensilsCrossed,
} from "lucide-react";
import { extractHandleFromUrl } from "@/lib/shopify";
import { useCategoryMenu } from "@/hooks/useCategoryMenu";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";

/**
 * 배너 아래 「カテゴリー」 원형 아이콘 섹션 (#185, 시안의 Our Categories).
 *
 * 항목은 CategoryNav 와 같은 Shopify 메뉴에서 가져와 둘이 어긋나지 않게 한다.
 * 아이콘은 카테고리 이름의 키워드로 고르고, 매칭이 없으면 발바닥. 색은 파스텔 8색을 순환.
 * 어드민에서 메뉴를 바꿔도 코드 수정 없이 따라간다.
 * 모바일은 가로 스크롤, PC 는 줄바꿈해 가운데 정렬 (가운데 정렬 + 가로 스크롤을 같이 쓰면 앞쪽이 잘려 못 간다).
 */
const ICON_RULES: { test: RegExp; icon: LucideIcon }[] = [
  { test: /おもちゃ|toy/i, icon: Bone },
  { test: /散歩|お出かけ|walk/i, icon: Footprints },
  { test: /リビング|living|ベッド|home/i, icon: Sofa },
  { test: /衛生|ケア|clean|care/i, icon: Sparkles },
  { test: /食器|フード|ごはん|food|おやつ/i, icon: UtensilsCrossed },
  { test: /衣類|服|ウェア|cloth|wear|ssfw/i, icon: Shirt },
  { test: /猫|ねこ|cat/i, icon: Cat },
  { test: /apple/i, icon: Apple },
];

const PASTELS = [
  "bg-orange-100 text-orange-500",
  "bg-yellow-100 text-yellow-600",
  "bg-pink-100 text-pink-500",
  "bg-sky-100 text-sky-500",
  "bg-emerald-100 text-emerald-500",
  "bg-violet-100 text-violet-500",
  "bg-amber-100 text-amber-600",
  "bg-rose-100 text-rose-500",
];

function pickIcon(title: string): LucideIcon {
  return ICON_RULES.find(r => r.test.test(title))?.icon ?? PawPrint;
}

interface CategoryCirclesProps {
  onSelect: (handle: string | null) => void;
}

export function CategoryCircles({ onSelect }: CategoryCirclesProps) {
  const { menu, collections } = useCategoryMenu();

  const items: { key: string; title: string; handle: string | null; icon: LucideIcon }[] = [
    { key: "all", title: "すべて", handle: null, icon: LayoutGrid },
  ];

  if (menu) {
    menu.items
      .filter(item => item.type === "COLLECTION" || item.url.includes("/collections/"))
      .forEach(item => {
        const handle = extractHandleFromUrl(item.url);
        if (handle) items.push({ key: item.id, title: item.title, handle, icon: pickIcon(item.title) });
      });
  } else {
    collections
      .filter(c => c.handle !== "frontpage")
      .forEach(c => items.push({ key: c.id, title: c.title, handle: c.handle, icon: pickIcon(c.title) }));
  }

  if (items.length <= 1) return null;

  return (
    <section className="mt-8 animate-fade-up" style={{ animationDelay: "0.1s" }}>
      <h2 className="text-lg md:text-xl font-bold text-foreground text-center mb-4">カテゴリー</h2>
      <div className="flex gap-3 md:gap-5 md:gap-y-6 px-4 overflow-x-auto scrollbar-hide md:overflow-visible md:flex-wrap md:justify-center pb-1">
        {items.map(({ key, title, handle, icon: Icon }, i) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              if (handle) track("category_click", { name: title, handle, source: "home_circles" });
              onSelect(handle);
            }}
            className="group flex-shrink-0 flex flex-col items-center gap-2 w-[72px] md:w-24"
          >
            <span
              className={cn(
                "w-16 h-16 md:w-[88px] md:h-[88px] rounded-full flex items-center justify-center shadow-sm transition-transform duration-200 group-hover:scale-105 group-hover:shadow-md",
                PASTELS[i % PASTELS.length],
              )}
            >
              <Icon className="h-6 w-6 md:h-8 md:w-8" strokeWidth={1.8} />
            </span>
            <span className="text-[11px] md:text-xs font-medium text-foreground text-center leading-tight line-clamp-2 break-keep">
              {title}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
