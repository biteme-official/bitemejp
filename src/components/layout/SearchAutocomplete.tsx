import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Clock, TrendingUp, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import { fetchProducts, ShopifyProduct } from "@/lib/shopify";
import { cn } from "@/lib/utils";

interface SearchAutocompleteProps {
  onSearch: (query: string) => void;
}

interface ProductSuggestion {
  id: string;
  title: string;
  handle: string;
  imageUrl?: string;
  price: string;
  currencyCode: string;
}

const RECENT_SEARCHES_KEY = "bite-me-recent-searches";
const MAX_RECENT_SEARCHES = 5;

export function SearchAutocomplete({ onSearch }: SearchAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Load recent searches from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (saved) {
      try {
        setRecentSearches(JSON.parse(saved));
      } catch {
        setRecentSearches([]);
      }
    }
  }, []);

  // Save recent search
  const saveRecentSearch = useCallback((searchTerm: string) => {
    const trimmed = searchTerm.trim();
    if (!trimmed) return;
    
    setRecentSearches((prev) => {
      const filtered = prev.filter((s) => s.toLowerCase() !== trimmed.toLowerCase());
      const updated = [trimmed, ...filtered].slice(0, MAX_RECENT_SEARCHES);
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Clear a specific recent search
  const clearRecentSearch = useCallback((searchTerm: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRecentSearches((prev) => {
      const updated = prev.filter((s) => s !== searchTerm);
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Fetch product suggestions
  const fetchSuggestions = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    setLoading(true);
    try {
      // Sanitize search input to prevent GraphQL injection
      const sanitized = searchQuery.replace(/[\\"`${}]/g, '');
      // Use Shopify's native full-text search for better Japanese/English matching
      const shopifyQuery = sanitized;
      const response = await fetchProducts(6, shopifyQuery);
      
      const productSuggestions: ProductSuggestion[] = response.products.map(
        (product: ShopifyProduct) => ({
          id: product.node.id,
          title: product.node.title,
          handle: product.node.handle,
          imageUrl: product.node.images.edges[0]?.node.url,
          price: product.node.priceRange.minVariantPrice.amount,
          currencyCode: product.node.priceRange.minVariantPrice.currencyCode,
        })
      );
      
      setSuggestions(productSuggestions);
    } catch (error) {
      console.error("Failed to fetch suggestions:", error);
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (query.trim().length >= 2) {
      debounceRef.current = setTimeout(() => {
        fetchSuggestions(query);
      }, 300);
    } else {
      setSuggestions([]);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, fetchSuggestions]);

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Handle search submission
  const handleSubmit = useCallback(() => {
    if (query.trim()) {
      saveRecentSearch(query.trim());
      onSearch(query.trim());
      setIsOpen(false);
      inputRef.current?.blur();
    }
  }, [query, onSearch, saveRecentSearch]);

  // Handle selecting a suggestion
  const handleSelectSuggestion = useCallback((suggestion: ProductSuggestion) => {
    saveRecentSearch(suggestion.title);
    setIsOpen(false);
    navigate(`/product/${suggestion.handle}`);
  }, [navigate, saveRecentSearch]);

  // Handle selecting a recent search
  const handleSelectRecent = useCallback((searchTerm: string) => {
    setQuery(searchTerm);
    saveRecentSearch(searchTerm);
    onSearch(searchTerm);
    setIsOpen(false);
  }, [onSearch, saveRecentSearch]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const totalItems = suggestions.length + (query.length < 2 ? recentSearches.length : 0);
    
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev < totalItems - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : totalItems - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0) {
        if (query.length >= 2 && activeIndex < suggestions.length) {
          handleSelectSuggestion(suggestions[activeIndex]);
        } else if (query.length < 2 && activeIndex < recentSearches.length) {
          handleSelectRecent(recentSearches[activeIndex]);
        }
      } else {
        handleSubmit();
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  }, [suggestions, recentSearches, activeIndex, query.length, handleSelectSuggestion, handleSelectRecent, handleSubmit]);

  // Reset active index when suggestions change
  useEffect(() => {
    setActiveIndex(-1);
  }, [suggestions, recentSearches]);

  const showDropdown = isOpen && (suggestions.length > 0 || (query.length < 2 && recentSearches.length > 0));

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          ref={inputRef}
          type="text"
          placeholder={t('nav.searchProducts')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          className="w-full pl-4 pr-10 h-10 rounded-lg border-2 border-primary/30 focus:border-primary"
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={handleSubmit}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-primary"
        >
          <Search className="h-5 w-5" />
        </Button>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Loading indicator */}
          {loading && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              {t('common.loading')}...
            </div>
          )}

          {/* Recent searches (only when query is short) */}
          {query.length < 2 && recentSearches.length > 0 && !loading && (
            <div className="py-2">
              <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <Clock className="h-3 w-3" />
                {t('search.recentSearches')}
              </div>
              {recentSearches.map((term, index) => (
                <button
                  key={term}
                  onClick={() => handleSelectRecent(term)}
                  className={cn(
                    "w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-secondary/50 transition-colors",
                    activeIndex === index && "bg-secondary/50"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <span>{term}</span>
                  </div>
                  <button
                    onClick={(e) => clearRecentSearch(term, e)}
                    className="p-1 hover:bg-secondary rounded-full"
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                </button>
              ))}
            </div>
          )}

          {/* Product suggestions */}
          {suggestions.length > 0 && !loading && (
            <div className="py-2">
              <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <TrendingUp className="h-3 w-3" />
                {t('search.suggestions')}
              </div>
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  onClick={() => handleSelectSuggestion(suggestion)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/50 transition-colors",
                    activeIndex === index && "bg-secondary/50"
                  )}
                >
                  {suggestion.imageUrl && (
                    <img
                      src={suggestion.imageUrl}
                      alt={suggestion.title}
                      className="w-10 h-10 object-cover rounded-md bg-secondary"
                    />
                  )}
                  <div className="flex-1 text-left min-w-0">
                    <p className="text-sm font-medium truncate">{suggestion.title}</p>
                    <p className="text-xs text-muted-foreground" translate="no">
                      {new Intl.NumberFormat(
                        suggestion.currencyCode === 'JPY' ? 'ja-JP' : suggestion.currencyCode === 'KRW' ? 'ko-KR' : 'en-US',
                        {
                          style: 'currency',
                          currency: suggestion.currencyCode,
                          minimumFractionDigits: ['JPY', 'KRW'].includes(suggestion.currencyCode) ? 0 : 2,
                        }
                      ).format(parseFloat(suggestion.price))}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* No results */}
          {query.length >= 2 && suggestions.length === 0 && !loading && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              {t('search.noResults')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
