import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { extractHandleFromUrl } from '@/lib/shopify';
import { useCategoryMenu } from '@/hooks/useCategoryMenu';
import { track } from '@/lib/track';

/**
 * 1차 카테고리는 칩이 아니라 텍스트 링크 (#185, 시안의 상단 내비).
 * 활성 항목은 굵게 + 브랜드색 밑줄. PC 는 가운데 정렬, 모바일은 가로 스크롤.
 * 진짜 <a>(/?collection=…) 라 Ctrl+클릭·휠클릭이면 새 탭. 같은 탭 클릭은 preventDefault 하고
 * 기존 onSelect 로 쿼리만 바꾼다(ALL 클릭 시 검색어까지 지우는 기존 동작 유지).
 */
const isPlainLeftClick = (e: React.MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const TOP_LINK =
  'flex-shrink-0 px-3 py-2.5 text-sm whitespace-nowrap border-b-2 transition-colors';
const TOP_LINK_ACTIVE = 'font-bold text-foreground border-primary';
const TOP_LINK_IDLE = 'font-medium text-muted-foreground border-transparent hover:text-foreground';

interface CategoryNavProps {
  selectedCollection: string | null;
  onSelect: (handle: string | null) => void;
}

export function CategoryNav({ selectedCollection, onSelect }: CategoryNavProps) {
  const { menu, collections } = useCategoryMenu();
  const topRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  // Build top-level items from menu or fallback collections
  const topItems = menu
    ? menu.items.filter(
        item => item.type === 'COLLECTION' || item.url.includes('/collections/')
      )
    : collections
        .filter(c => c.handle !== 'frontpage')
        .map(c => ({
          id: c.id,
          title: c.title,
          url: `https://placeholder/collections/${c.handle}`,
          type: 'COLLECTION',
          items: [],
        }));

  if (topItems.length === 0) return null;

  // Find the active top-level item (direct match or parent of selected sub-category)
  const activeTopItem = topItems.find(item => {
    const handle = extractHandleFromUrl(item.url);
    if (handle === selectedCollection) return true;
    return item.items?.some(
      child => extractHandleFromUrl(child.url) === selectedCollection
    );
  }) ?? null;

  const subItems =
    activeTopItem?.items?.filter(
      child => child.type === 'COLLECTION' || child.url.includes('/collections/')
    ) ?? [];

  return (
    <div className="bg-background border-b border-border">
      {/* Top-level category chips */}
      <div
        ref={topRef}
        className="max-w-7xl mx-auto flex gap-1 md:gap-2 md:justify-center overflow-x-auto scrollbar-hide px-2 md:px-4"
      >
        <Link
          to="/"
          onClick={(e) => { if (isPlainLeftClick(e)) { e.preventDefault(); onSelect(null); } }}
          className={cn(TOP_LINK, !selectedCollection ? TOP_LINK_ACTIVE : TOP_LINK_IDLE)}
        >
          すべて
        </Link>

        {topItems.map(item => {
          const handle = extractHandleFromUrl(item.url);
          const isActive =
            handle === selectedCollection ||
            item.items?.some(
              child => extractHandleFromUrl(child.url) === selectedCollection
            );

          if (!handle) return null;
          return (
            <Link
              key={item.id}
              to={`/?collection=${encodeURIComponent(handle)}`}
              onClick={(e) => {
                track('category_click', { name: item.title, handle });
                if (isPlainLeftClick(e)) { e.preventDefault(); onSelect(handle); }
              }}
              className={cn(TOP_LINK, isActive ? TOP_LINK_ACTIVE : TOP_LINK_IDLE)}
            >
              {item.title}
            </Link>
          );
        })}
      </div>

      {/* Sub-category chips — shown when parent is active and has children */}
      {subItems.length > 0 && (
        <div className="border-t border-border/50 bg-secondary/20">
        <div
          ref={subRef}
          className="max-w-7xl mx-auto flex gap-2 overflow-x-auto scrollbar-hide px-4 py-2"
        >
          {/* Show parent as "ALL in category" option */}
          <button
            onClick={() => {
              const handle = extractHandleFromUrl(activeTopItem!.url);
              if (handle) onSelect(handle);
            }}
            className={cn(
              'flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap',
              extractHandleFromUrl(activeTopItem!.url) === selectedCollection
                ? 'bg-foreground text-background'
                : 'bg-background border border-border text-foreground hover:bg-secondary'
            )}
          >
            すべて
          </button>

          {subItems.map(child => {
            const handle = extractHandleFromUrl(child.url);
            const isActive = handle === selectedCollection;

            return (
              <button
                key={child.id}
                onClick={() => { if (handle) { track('category_click', { name: child.title, handle }); onSelect(handle); } }}
                className={cn(
                  'flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap',
                  isActive
                    ? 'bg-foreground text-background'
                    : 'bg-background border border-border text-foreground hover:bg-secondary'
                )}
              >
                {child.title}
              </button>
            );
          })}
        </div>
        </div>
      )}
    </div>
  );
}
