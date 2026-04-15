import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { extractHandleFromUrl } from '@/lib/shopify';
import { useCategoryMenu } from '@/hooks/useCategoryMenu';

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
        className="max-w-7xl mx-auto flex gap-2 overflow-x-auto scrollbar-hide px-4 py-2"
      >
        <button
          onClick={() => onSelect(null)}
          className={cn(
            'flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap',
            !selectedCollection
              ? 'bg-foreground text-background'
              : 'bg-secondary text-foreground hover:bg-secondary/80'
          )}
        >
          ALL
        </button>

        {topItems.map(item => {
          const handle = extractHandleFromUrl(item.url);
          const isActive =
            handle === selectedCollection ||
            item.items?.some(
              child => extractHandleFromUrl(child.url) === selectedCollection
            );

          return (
            <button
              key={item.id}
              onClick={() => handle && onSelect(handle)}
              className={cn(
                'flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap',
                isActive
                  ? 'bg-foreground text-background'
                  : 'bg-secondary text-foreground hover:bg-secondary/80'
              )}
            >
              {item.title}
            </button>
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
              handle && onSelect(handle);
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
                onClick={() => handle && onSelect(handle)}
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
