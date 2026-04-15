import { useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/hooks/useTranslation";

export type SortOption = "default" | "price-asc" | "price-desc" | "title-asc" | "title-desc";

export interface FilterState {
  priceRange: [number, number];
  availability: "all" | "available" | "sold-out";
}

interface ProductFiltersProps {
  sortOption: SortOption;
  onSortChange: (sort: SortOption) => void;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  maxPrice: number;
  activeFilterCount: number;
}

export function ProductFilters({
  sortOption,
  onSortChange,
  filters,
  onFiltersChange,
  maxPrice,
  activeFilterCount,
}: ProductFiltersProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [tempFilters, setTempFilters] = useState<FilterState>(filters);
  const { t, formatPrice } = useTranslation();

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setTempFilters(filters);
    }
    setIsOpen(open);
  };

  const sortOptions: { value: SortOption; labelKey: string }[] = [
    { value: "default", labelKey: "filters.sortOptions.default" },
    { value: "price-asc", labelKey: "filters.sortOptions.priceAsc" },
    { value: "price-desc", labelKey: "filters.sortOptions.priceDesc" },
    { value: "title-asc", labelKey: "filters.sortOptions.titleAsc" },
    { value: "title-desc", labelKey: "filters.sortOptions.titleDesc" },
  ];

  const availabilityOptions = [
    { value: "all", labelKey: "filters.all" },
    { value: "available", labelKey: "filters.available" },
    { value: "sold-out", labelKey: "product.soldOut" },
  ];

  const handleApplyFilters = () => {
    onFiltersChange(tempFilters);
    setIsOpen(false);
  };

  const handleResetFilters = () => {
    const defaultFilters: FilterState = {
      priceRange: [0, maxPrice],
      availability: "all",
    };
    setTempFilters(defaultFilters);
    onFiltersChange(defaultFilters);
  };

  return (
    <div className="flex items-center gap-2 mb-4">
      {/* Sort Dropdown */}
      <Select value={sortOption} onValueChange={(value) => onSortChange(value as SortOption)}>
        <SelectTrigger className="w-[160px] h-9 text-sm">
          <SelectValue placeholder={t('filters.sortOptions.default')} />
        </SelectTrigger>
        <SelectContent>
          {sortOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Filter Button */}
      <Sheet open={isOpen} onOpenChange={handleOpenChange}>
        <SheetTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            {t('filters.filter')}
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center text-xs">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="h-[70vh] rounded-t-2xl">
          <SheetHeader className="pb-4 border-b border-border">
            <div className="flex items-center justify-between">
              <SheetTitle>{t('filters.filter')}</SheetTitle>
              <Button variant="ghost" size="sm" onClick={handleResetFilters}>
                {t('filters.reset')}
              </Button>
            </div>
          </SheetHeader>

          <div className="py-6 space-y-8 overflow-y-auto max-h-[calc(70vh-140px)]">
            {/* Price Range */}
            <div>
              <h3 className="text-sm font-semibold mb-4">{t('filters.priceRange')}</h3>
              <div className="px-2">
                <Slider
                  value={tempFilters.priceRange}
                  onValueChange={(value) =>
                    setTempFilters((prev) => ({ ...prev, priceRange: value as [number, number] }))
                  }
                  max={maxPrice}
                  min={0}
                  step={250}
                  className="mb-4"
                />
                {/* Price markers */}
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                  <span>¥0</span>
                  <span>¥2,500</span>
                  <span>¥5,000</span>
                  <span>¥7,500</span>
                  <span>¥10,000</span>
                </div>
                <div className="flex items-center justify-between text-sm font-medium">
                  <span>{formatPrice(tempFilters.priceRange[0], 'JPY')}</span>
                  <span className="text-muted-foreground">~</span>
                  <span>{formatPrice(tempFilters.priceRange[1], 'JPY')}</span>
                </div>
              </div>
            </div>

            {/* Availability */}
            <div>
              <h3 className="text-sm font-semibold mb-4">{t('filters.availability')}</h3>
              <div className="flex flex-wrap gap-2">
                {availabilityOptions.map((option) => (
                  <Button
                    key={option.value}
                    variant={tempFilters.availability === option.value ? "default" : "outline"}
                    size="sm"
                    onClick={() =>
                      setTempFilters((prev) => ({
                        ...prev,
                        availability: option.value as FilterState["availability"],
                      }))
                    }
                  >
                    {t(option.labelKey)}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* Apply Button */}
          <div className="absolute bottom-0 left-0 right-0 p-4 bg-background border-t border-border">
            <Button onClick={handleApplyFilters} className="w-full">
              {t('filters.apply')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Active Filters */}
      {activeFilterCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleResetFilters}
          className="h-9 text-muted-foreground"
        >
          <X className="h-4 w-4 mr-1" />
          {t('filters.clearFilters')}
        </Button>
      )}
    </div>
  );
}
