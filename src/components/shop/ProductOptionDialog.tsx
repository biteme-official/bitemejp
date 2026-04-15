import { useState, useEffect } from 'react';
import { ShopifyProduct, formatPrice } from '@/lib/shopify';
import { useCartStore } from '@/stores/cartStore';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Minus, Plus, Check, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface ProductOptionDialogProps {
  product: ShopifyProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ProductOptionDialog = ({ product, open, onOpenChange }: ProductOptionDialogProps) => {
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const addItem = useCartStore(state => state.addItem);
  // Reset state when product changes
  useEffect(() => {
    if (product?.node?.options) {
      const defaults: Record<string, string> = {};
      product.node.options.forEach(option => {
        if (option.values.length > 0) {
          defaults[option.name] = option.values[0];
        }
      });
      setSelectedOptions(defaults);
      setQuantity(1);
    }
  }, [product]);

  if (!product) return null;

  const productNode = product.node;

  const getSelectedVariant = () => {
    return productNode.variants.edges.find(({ node }) => {
      return node.selectedOptions.every(
        opt => selectedOptions[opt.name] === opt.value
      );
    })?.node || productNode.variants.edges[0]?.node;
  };

  const handleAddToCart = () => {
    const variant = getSelectedVariant();
    if (!variant) return;

    addItem({
      product,
      variantId: variant.id,
      variantTitle: variant.title,
      price: variant.price,
      quantity,
      quantityAvailable: variant.quantityAvailable ?? null,
      selectedOptions: variant.selectedOptions,
    });

    toast.success('Added to cart', {
      description: `${productNode.title} x ${quantity}`,
      position: 'top-center',
    });

    onOpenChange(false);
  };

  const selectedVariant = getSelectedVariant();
  const price = selectedVariant?.price || productNode.priceRange.minVariantPrice;
  const displayPrice = parseFloat(price.amount);
  const totalPrice = displayPrice * quantity;
  const maxQuantity = selectedVariant?.quantityAvailable ?? 99;
  const hasOptions = productNode.options.some(
    opt => !(opt.name === 'Title' && opt.values.length === 1 && opt.values[0] === 'Default Title')
  );

  const image = productNode.images.edges[0]?.node;

  const colorMap: Record<string, string> = {
    'black': '#000000',
    'white': '#FFFFFF',
    'red': '#EF4444',
    'blue': '#3B82F6',
    'green': '#22C55E',
    'yellow': '#EAB308',
    'pink': '#EC4899',
    'purple': '#A855F7',
    'orange': '#F97316',
    'brown': '#92400E',
    'gray': '#6B7280',
    'grey': '#6B7280',
    'navy': '#1E3A5A',
    'beige': '#D4C4A8',
    'cream': '#FFFDD0',
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-left pr-8">Select Options</DialogTitle>
        </DialogHeader>

        {/* Product Info */}
        <div className="flex gap-3 pb-4 border-b border-border">
          {image && (
            <div className="w-20 h-20 rounded-lg overflow-hidden bg-muted flex-shrink-0">
              <img 
                src={image.url} 
                alt={image.altText || productNode.title} 
                className="w-full h-full object-cover"
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sm line-clamp-2 mb-1">{productNode.title}</h3>
            <span className="font-bold text-primary">
              {formatPrice(price.amount, price.currencyCode)}
            </span>
          </div>
        </div>

        {/* Options */}
        {hasOptions && productNode.options.map((option) => {
          if (option.name === 'Title' && option.values.length === 1 && option.values[0] === 'Default Title') {
            return null;
          }

          // Check if variants have UNIQUE images (not just the same default product image)
          const variantImagesForOption = option.values.map(value => {
            const variant = productNode.variants.edges.find(({ node }) =>
              node.selectedOptions.some(opt => opt.name === option.name && opt.value === value)
            )?.node;
            return variant?.image?.url || null;
          });
          const uniqueImages = new Set(variantImagesForOption.filter(Boolean));
          const hasVariantImages = uniqueImages.size > 1;

          // Show swatch UI if variants have unique images registered
          const showSwatchUI = hasVariantImages;

          // Helper to get variant image for a specific option value
          const getVariantImageForOption = (optionValue: string) => {
            const variant = productNode.variants.edges.find(({ node }) =>
              node.selectedOptions.some(opt => opt.name === option.name && opt.value === optionValue)
            )?.node;
            return variant?.image?.url || null;
          };

          const getVariantForOption = (optionValue: string) => {
            const testOptions = { ...selectedOptions, [option.name]: optionValue };
            return productNode.variants.edges.find(({ node }) => {
              return node.selectedOptions.every(
                opt => testOptions[opt.name] === opt.value
              );
            })?.node;
          };

          return (
            <div key={option.name} className="py-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm text-muted-foreground">{option.name}:</span>
                <span className="text-sm font-medium text-foreground">{selectedOptions[option.name]}</span>
              </div>

              {showSwatchUI ? (
                <div className="flex flex-wrap gap-3">
                  {option.values.map((value) => {
                    const variant = getVariantForOption(value);
                    const isAvailable = variant?.availableForSale ?? true;
                    const isSelected = selectedOptions[option.name] === value;
                    const variantImage = getVariantImageForOption(value);
                    const bgColor = colorMap[value.toLowerCase()] || '#9CA3AF';

                    return (
                      <button
                        key={value}
                        onClick={() => setSelectedOptions(prev => ({ ...prev, [option.name]: value }))}
                        disabled={!isAvailable}
                        className={cn(
                          "flex flex-col items-center gap-1 transition-all",
                          !isAvailable && "opacity-40 cursor-not-allowed"
                        )}
                        title={value}
                      >
                        <div className={cn(
                          "w-16 h-16 rounded-lg border-2 relative flex items-center justify-center overflow-hidden",
                          isSelected
                            ? "border-foreground ring-1 ring-foreground"
                            : "border-border hover:border-foreground/50",
                        )}>
                          {variantImage ? (
                            <img src={variantImage} alt={value} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full" style={{ backgroundColor: bgColor }} />
                          )}
                          {isSelected && (
                            <div className="absolute top-0.5 right-0.5 bg-foreground rounded-full p-0.5">
                              <Check className="h-2.5 w-2.5 text-background" />
                            </div>
                          )}
                          {!isAvailable && (
                            <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
                              <div className="w-full h-0.5 bg-foreground/60 rotate-45 absolute" />
                            </div>
                          )}
                        </div>
                        <span className={cn(
                          "text-xs capitalize",
                          isSelected ? "font-semibold text-foreground" : "text-muted-foreground"
                        )}>
                          {value}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {option.values.map((value) => {
                    const variant = getVariantForOption(value);
                    const isAvailable = variant?.availableForSale ?? true;
                    const isSelected = selectedOptions[option.name] === value;

                    return (
                      <button
                        key={value}
                        onClick={() => setSelectedOptions(prev => ({ ...prev, [option.name]: value }))}
                        disabled={!isAvailable}
                        className={cn(
                          "min-w-[48px] py-2 px-4 text-sm font-medium transition-all border rounded-md",
                          isSelected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:border-foreground/50",
                          !isAvailable && "line-through opacity-50 cursor-not-allowed"
                        )}
                      >
                        {value}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Quantity */}
        <div className="py-3 border-t border-border">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">Quantity</span>
            {maxQuantity !== null && maxQuantity < 99 && (
              <span className="text-xs text-muted-foreground">
                {maxQuantity} available
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              disabled={quantity <= 1}
              className="h-10 w-10"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <span className="text-lg font-semibold w-8 text-center">{quantity}</span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setQuantity(Math.min(maxQuantity, quantity + 1))}
              disabled={quantity >= maxQuantity}
              className="h-10 w-10"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Add to Cart Button */}
        <div className="pt-4 border-t border-border">
          <Button 
            onClick={handleAddToCart} 
            className="w-full h-12 text-base font-semibold"
            disabled={!selectedVariant?.availableForSale}
          >
            <ShoppingCart className="h-5 w-5 mr-2" />
            Add to Cart - {formatPrice(totalPrice.toString(), price.currencyCode)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
