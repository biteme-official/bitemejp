import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ShoppingCart, Minus, Plus, Trash2, ExternalLink, Loader2 } from "lucide-react";
import { useCartStore } from "@/stores/cartStore";
import { formatPrice } from "@/lib/shopify";
import { ThresholdBanner } from "./ThresholdBanner";
import { useTranslation } from "@/hooks/useTranslation";
import { safeNavigate } from "@/lib/browser-utils";
import { trackViewCart, trackBeginCheckout, trackRemoveFromCart, shopifyToGA4Item } from "@/lib/ga4-ecommerce";

interface CartDrawerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}

export const CartDrawer = ({ open: controlledOpen, onOpenChange, showTrigger = true }: CartDrawerProps) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    items,
    isLoading,
    updateQuantity,
    removeItem,
    createCheckout,
    getTotalItems,
  } = useCartStore();

  // Support both controlled and uncontrolled modes
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setIsOpen = onOpenChange || setInternalOpen;

  // GA4: view_cart event when drawer opens
  useEffect(() => {
    if (isOpen && items.length > 0) {
      const ga4Items = items.map(item => shopifyToGA4Item(
        item.product.node,
        { title: item.variantTitle, price: item.price },
        item.quantity
      ));
      const total = items.reduce((sum, item) => sum + (parseFloat(item.price.amount) * item.quantity), 0);
      trackViewCart(ga4Items, items[0]?.price.currencyCode || 'USD', total);
    }
  }, [isOpen]);

  const totalItems = getTotalItems();
  const currencyCode = items[0]?.price.currencyCode || 'USD';

  // Calculate total price from selected items only (or all if none selected)
  const { totalPrice, selectedCount } = useMemo(() => {
    const itemsToCalculate = selectedItems.size > 0
      ? items.filter(item => selectedItems.has(item.variantId))
      : items;

    const total = itemsToCalculate.reduce((sum, item) => {
      const price = parseFloat(item.price.amount) || 0;
      const qty = item.quantity || 0;
      return sum + (price * qty);
    }, 0);

    return {
      totalPrice: total,
      selectedCount: selectedItems.size > 0 ? selectedItems.size : items.length
    };
  }, [items, selectedItems]);

  // Check if all items are selected
  const allSelected = items.length > 0 && selectedItems.size === items.length;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedItems(new Set(items.map(item => item.variantId)));
    } else {
      setSelectedItems(new Set());
    }
  };

  const handleSelectItem = (variantId: string, checked: boolean) => {
    const newSelected = new Set(selectedItems);
    if (checked) {
      newSelected.add(variantId);
    } else {
      newSelected.delete(variantId);
    }
    setSelectedItems(newSelected);
  };

  const handleDeleteSelected = () => {
    if (selectedItems.size === 0) return;
    selectedItems.forEach(variantId => {
      const item = items.find(i => i.variantId === variantId);
      if (item) {
        trackRemoveFromCart(shopifyToGA4Item(
          item.product.node,
          { title: item.variantTitle, price: item.price },
          item.quantity
        ));
      }
      removeItem(variantId);
    });
    setSelectedItems(new Set());
  };

  const handleCheckout = () => {
    const itemsToCheckout = selectedItems.size > 0
      ? items.filter(item => selectedItems.has(item.variantId))
      : items;

    // GA4: begin_checkout event
    const ga4Items = itemsToCheckout.map(item => shopifyToGA4Item(
      item.product.node,
      { title: item.variantTitle, price: item.price },
      item.quantity
    ));

    trackBeginCheckout(ga4Items, currencyCode, totalPrice);

    setIsOpen(false);
    navigate('/checkout');
  };

  const handleProductClick = (handle: string) => {
    setIsOpen(false);
    navigate(`/product/${handle}`);
  };

  const getItemCountText = () => {
    if (totalItems === 0) return t('cart.empty');
    return `${totalItems} ${t('cart.itemCount')}`;
  };

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      {showTrigger && (
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="relative">
            <ShoppingCart className="h-5 w-5" />
            {totalItems > 0 && (
              <Badge className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs bg-primary text-primary-foreground">
                {totalItems}
              </Badge>
            )}
          </Button>
        </SheetTrigger>
      )}

      <SheetContent className="w-full sm:max-w-lg flex flex-col h-full" translate="no">
        <SheetHeader className="flex-shrink-0">
          <SheetTitle>{t('cart.title')}</SheetTitle>
          <SheetDescription>
            {getItemCountText()}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col flex-1 pt-6 min-h-0">
          {items.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <ShoppingCart className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">{t('cart.empty')}</p>
              </div>
            </div>
          ) : (
            <>
              {/* Threshold Banner */}
              <ThresholdBanner />

              {/* Select All & Delete Selected */}
              <div className="flex items-center justify-between py-3 border-b border-border mb-3">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="select-all"
                    checked={allSelected}
                    onCheckedChange={handleSelectAll}
                    className="border-primary data-[state=checked]:bg-primary"
                  />
                  <label htmlFor="select-all" className="text-sm font-medium cursor-pointer">
                    Select All
                  </label>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={handleDeleteSelected}
                  disabled={selectedItems.size === 0}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto pr-2 min-h-0">
                <div className="space-y-4">
                  {items.map((item) => (
                    <div key={item.variantId} className="flex gap-3 p-2 bg-muted/30 rounded-lg">
                      {/* Checkbox */}
                      <div className="flex items-center">
                        <Checkbox
                          checked={selectedItems.has(item.variantId)}
                          onCheckedChange={(checked) => handleSelectItem(item.variantId, checked as boolean)}
                          className="border-primary data-[state=checked]:bg-primary"
                        />
                      </div>

                      {/* Product Image - Clickable */}
                      <button
                        onClick={() => handleProductClick(item.product.node.handle)}
                        className="w-16 h-16 bg-muted rounded-md overflow-hidden flex-shrink-0 hover:opacity-80 transition-opacity"
                      >
                        {item.product.node.images?.edges?.[0]?.node && (
                          <img
                            src={item.product.node.images.edges[0].node.url}
                            alt={item.product.node.title}
                            className="w-full h-full object-cover"
                          />
                        )}
                      </button>

                      {/* Product Info - Clickable */}
                      <div className="flex-1 min-w-0">
                        <button
                          onClick={() => handleProductClick(item.product.node.handle)}
                          className="text-left hover:text-primary transition-colors"
                        >
                          <h4 className="font-medium text-sm line-clamp-2">{item.product.node.title}</h4>
                        </button>
                        {item.variantTitle !== 'Default Title' && (
                          <p className="text-xs text-muted-foreground">
                            {item.selectedOptions.map(option => option.value).join(' / ')}
                          </p>
                        )}
                        <div className="mt-1">
                          <p className="text-xs text-muted-foreground">
                            {formatPrice(item.price.amount, item.price.currencyCode)} x {item.quantity}
                          </p>
                          <p className="font-semibold text-sm text-primary">
                            {formatPrice((parseFloat(item.price.amount) * item.quantity).toFixed(2), item.price.currencyCode)}
                          </p>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col items-end gap-2 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => removeItem(item.variantId)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>

                        <div className="flex flex-col items-end gap-1">
                          {item.quantityAvailable !== null && item.quantityAvailable < 99 && (
                            <span className="text-[10px] text-muted-foreground">
                              max: {item.quantityAvailable}
                            </span>
                          )}
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => updateQuantity(item.variantId, item.quantity - 1)}
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <span className="w-8 text-center text-sm">{item.quantity}</span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => updateQuantity(item.variantId, item.quantity + 1)}
                              disabled={item.quantityAvailable !== null && item.quantity >= item.quantityAvailable}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex-shrink-0 space-y-4 pt-4 border-t mt-4">
                <div className="flex justify-between items-center">
                  <span className="text-lg font-semibold">
                    {t('cart.total')} ({selectedCount} {t('cart.itemCount') || 'items'})
                  </span>
                  <span className="text-xl font-bold">
                    {formatPrice(totalPrice.toFixed(2), currencyCode)}
                  </span>
                </div>

                <Button
                  onClick={handleCheckout}
                  className="w-full"
                  size="lg"
                  disabled={items.length === 0 || isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t('cart.creatingCheckout')}
                    </>
                  ) : (
                    <>
                      {t('cart.checkout')}
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
