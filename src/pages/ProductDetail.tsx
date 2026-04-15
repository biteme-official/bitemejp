import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Share2, Minus, Plus, ShoppingCart, Check, Truck, Shield, Heart } from "lucide-react";
import DOMPurify from "dompurify";

const sanitizeHtml = (html: string): string =>
  DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'blockquote'], ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'style', 'target', 'rel', 'width', 'height'] });
import biteMeLogo from "@/assets/bite-me-logo.png";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fetchProductByHandle, formatPrice, ShopifyProduct } from "@/lib/shopify";
import { trackViewItem, trackAddToCart, shopifyToGA4Item } from "@/lib/ga4-ecommerce";
import { useCartStore } from "@/stores/cartStore";
import { useWishlistStore } from "@/stores/wishlistStore";
import { toast } from "sonner";
import { useTranslation } from "@/hooks/useTranslation";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { Footer } from "@/components/layout/Footer";

// Product detail skeleton component
function ProductDetailSkeleton() {
  return (
    <div className="max-w-lg mx-auto bg-background min-h-screen pb-32">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-4 h-14">
          <Skeleton className="h-9 w-9 rounded-md" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-9 rounded-md" />
            <Skeleton className="h-9 w-9 rounded-md" />
          </div>
        </div>
      </header>

      {/* Image Gallery Skeleton */}
      <div className="bg-secondary">
        <Skeleton className="aspect-square w-full" />
        <div className="flex gap-2 p-4 justify-center">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg" />
          ))}
        </div>
      </div>

      {/* Product Info Skeleton */}
      <div className="px-4 pt-4 space-y-6">
        {/* Title & Price */}
        <div className="space-y-3">
          <Skeleton className="h-7 w-3/4" />
          <Skeleton className="h-8 w-32" />
        </div>

        {/* Options Skeleton */}
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <div className="flex gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="w-10 h-10 rounded-full" />
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <div className="flex gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-16 rounded-md" />
            ))}
          </div>
        </div>

        {/* Quantity Skeleton */}
        <div className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <div className="flex items-center gap-3">
            <Skeleton className="w-10 h-10 rounded-lg" />
            <Skeleton className="w-12 h-6" />
            <Skeleton className="w-10 h-10 rounded-lg" />
          </div>
        </div>

        {/* Trust Badges Skeleton */}
        <div className="flex gap-4 py-4 border-y border-border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex-1 flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <div className="space-y-1">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-2 w-12" />
              </div>
            </div>
          ))}
        </div>

        {/* Description Skeleton */}
        <div className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      </div>

      {/* Fixed Bottom Bar Skeleton */}
      <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border p-4">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <div className="flex-1 space-y-1">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-6 w-24" />
          </div>
          <Skeleton className="flex-[2] h-12 rounded-md" />
        </div>
      </div>
    </div>
  );
}

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [product, setProduct] = useState<ShopifyProduct['node'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const thumbnailRef = useRef<HTMLDivElement>(null);
  const addItem = useCartStore(state => state.addItem);
  const totalCartItems = useCartStore(state => state.getTotalItems());
  const { isWishlisted, toggleItem: toggleWishlist } = useWishlistStore();

  // Scroll to top on mount
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const loadProduct = async () => {
      if (!id) return;
      try {
        const data = await fetchProductByHandle(id);
        setProduct(data);
        // GA4: view_item event
        if (data) {
          const variant = data.variants.edges[0]?.node;
          trackViewItem(shopifyToGA4Item(data, variant));
        }
        if (data?.options) {
          const defaults: Record<string, string> = {};
          data.options.forEach(option => {
            if (option.values.length > 0) {
              defaults[option.name] = option.values[0];
            }
          });
          setSelectedOptions(defaults);
        }
      } catch (err) {
        console.error('Failed to fetch product:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    loadProduct();
  }, [id]);

  const checkScrollability = () => {
    if (thumbnailRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = thumbnailRef.current;
      setCanScrollLeft(scrollLeft > 0);
      setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
    }
  };

  useEffect(() => {
    checkScrollability();
    window.addEventListener('resize', checkScrollability);
    return () => window.removeEventListener('resize', checkScrollability);
  }, [product]);

  const scrollThumbnails = (direction: 'left' | 'right') => {
    if (thumbnailRef.current) {
      const scrollAmount = 120;
      thumbnailRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth'
      });
      setTimeout(checkScrollability, 300);
    }
  };

  const getSelectedVariant = () => {
    if (!product) return null;
    return product.variants.edges.find(({ node }) => {
      return node.selectedOptions.every(
        opt => selectedOptions[opt.name] === opt.value
      );
    })?.node || product.variants.edges[0]?.node;
  };

  // When option at index i changes: keep options before i, reset all options after i to first valid value
  const handleOptionChange = (changedOptionName: string, newValue: string) => {
    if (!product) return;
    const changedIndex = product.options.findIndex(o => o.name === changedOptionName);
    const newOptions: Record<string, string> = {};

    // Keep options before the changed one
    for (let i = 0; i < changedIndex; i++) {
      newOptions[product.options[i].name] = selectedOptions[product.options[i].name];
    }
    // Set the changed option
    newOptions[changedOptionName] = newValue;

    // Always reset options after the changed one to their first valid value
    for (let i = changedIndex + 1; i < product.options.length; i++) {
      const option = product.options[i];
      const firstValid = option.values.find(val => {
        const test = { ...newOptions, [option.name]: val };
        return product.variants.edges.some(({ node }) =>
          Object.entries(test).every(([name, v]) =>
            node.selectedOptions.some(o => o.name === name && o.value === v)
          )
        );
      });
      newOptions[option.name] = firstValid ?? option.values[0];
    }

    setSelectedOptions(newOptions);
    setQuantity(1);
  };

  const handleAddToCart = () => {
    if (!product) return;
    const variant = getSelectedVariant();
    if (!variant) return;

    addItem({
      product: { node: product },
      variantId: variant.id,
      variantTitle: variant.title,
      price: variant.price,
      quantity,
      quantityAvailable: variant.quantityAvailable ?? null,
      selectedOptions: variant.selectedOptions,
    });

    // GA4: add_to_cart event
    trackAddToCart(shopifyToGA4Item(product, variant, quantity));

    toast.success(t('product.addedToCart'), {
      description: `${product.title} x ${quantity}`,
      position: 'top-center',
    });
  };

  const [isBuyingNow, setIsBuyingNow] = useState(false);

  const handleBuyNow = () => {
    if (!product) return;
    const variant = getSelectedVariant();
    if (!variant) return;

    // Add to cart then navigate to our checkout page
    addItem({
      product: { node: product } as any,
      variantId: variant.id,
      variantTitle: variant.title,
      price: variant.price,
      quantity,
      quantityAvailable: variant.quantityAvailable,
      selectedOptions: variant.selectedOptions,
    });

    navigate('/checkout');
  };

  if (loading) {
    return <ProductDetailSkeleton />;
  }

  if (!product) {
    return (
      <div className="max-w-lg mx-auto bg-background min-h-screen p-4">
        <Button
          variant="ghost"
          onClick={() => {
            if (window.history.length > 1) {
              navigate(-1);
            } else {
              navigate('/');
            }
          }}
          className="mb-4"
        >
          <ChevronLeft className="h-5 w-5 mr-2" />
          {t('product.back')}
        </Button>
        <p className="text-center text-muted-foreground">{t('product.notFound')}</p>
        {error && <p className="text-center text-destructive text-sm mt-2">Error: {error}</p>}
        {id && <p className="text-center text-muted-foreground text-xs mt-1">Handle: {id}</p>}
      </div>
    );
  }

  const images = product.images.edges;
  const selectedVariant = getSelectedVariant();
  const price = selectedVariant?.price || product.priceRange.minVariantPrice;
  const totalPrice = parseFloat(price.amount) * quantity;
  const maxQuantity = selectedVariant?.quantityAvailable ?? 99;

  return (
    <div className="bg-background min-h-screen flex flex-col pb-24 overflow-x-hidden w-full max-w-[100vw]">
      {/* Product Detail Header */}
      <header className="sticky top-0 z-50 bg-background border-b border-border">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-2">

            {/* Back Button */}
            <button
              onClick={() => {
                if (window.history.length > 1) {
                  navigate(-1);
                } else {
                  navigate('/');
                }
              }}
              className="p-1 text-foreground"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>

            {/* Logo */}
            <button onClick={() => navigate('/')} className="hover:opacity-80 transition-opacity">
              <img src={biteMeLogo} alt="BITE ME" className="h-[17px]" />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                const wishlisted = isWishlisted(product.id);
                toggleWishlist({
                  productId: product.id,
                  handle: product.handle,
                  title: product.title,
                  imageUrl: product.images.edges[0]?.node.url,
                  price: price.amount,
                  currencyCode: price.currencyCode,
                });
                toast.success(wishlisted ? '찜 목록에서 제거했습니다.' : '찜 목록에 추가했습니다.', {
                  position: 'top-center',
                });
              }}
              className="p-2 text-foreground"
            >
              <Heart
                className={cn(
                  "h-5 w-5 transition-colors",
                  isWishlisted(product.id) ? "fill-red-500 text-red-500" : ""
                )}
              />
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(window.location.href);
                toast.success('Link copied!', { position: 'top-center' });
              }}
              className="p-2 text-foreground"
            >
              <Share2 className="h-5 w-5" />
            </button>
            <CartDrawer />
          </div>
        </div>
      </header>

      <div className="max-w-lg mx-auto flex-1 w-full overflow-x-hidden">

      {/* Image Gallery */}
      <div className="bg-secondary">
        <div className="aspect-square flex items-center justify-center overflow-hidden">
          {images.length > 0 ? (
            <img
              src={images[selectedImage]?.node.url}
              alt={images[selectedImage]?.node.altText || product.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="text-8xl text-muted-foreground">🐕</div>
          )}
        </div>
        {images.length > 1 && (
          <div className="px-4 py-3 relative">
            {/* Left Arrow */}
            {canScrollLeft && (
              <button
                onClick={() => scrollThumbnails('left')}
                className="absolute left-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full bg-card/90 shadow-md flex items-center justify-center hover:bg-card transition-colors"
              >
                <ChevronLeft className="h-4 w-4 text-foreground" />
              </button>
            )}

            {/* Thumbnails */}
            <div
              ref={thumbnailRef}
              onScroll={checkScrollability}
              className="flex gap-2 overflow-x-auto scrollbar-hide px-1"
            >
              {images.map((img, index) => {
                // Append Shopify image size parameter for thumbnail optimisation
                const thumbUrl = img.node.url?.includes('?')
                  ? `${img.node.url}&width=120`
                  : `${img.node.url}?width=120`;
                return (
                  <button
                    key={index}
                    onClick={() => setSelectedImage(index)}
                    className={cn(
                      "w-12 h-12 sm:w-14 sm:h-14 min-w-[48px] sm:min-w-[56px] flex-shrink-0 rounded-lg bg-card overflow-hidden border-2 transition-colors",
                      selectedImage === index ? "border-primary" : "border-transparent"
                    )}
                  >
                    <img
                      src={thumbUrl}
                      alt={img.node.altText || `${product.title} ${index + 1}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </button>
                );
              })}
            </div>

            {/* Right Arrow */}
            {canScrollRight && (
              <button
                onClick={() => scrollThumbnails('right')}
                className="absolute right-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full bg-card/90 shadow-md flex items-center justify-center hover:bg-card transition-colors"
              >
                <ChevronRight className="h-4 w-4 text-foreground" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Product Info */}
      <div className="px-4 pt-4">
        {/* Title & Price */}
        <div className="mb-4">
          <h1 className="text-xl font-bold text-foreground mb-2">{product.title}</h1>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-foreground" translate="no">
              {formatPrice(price.amount, price.currencyCode)}
            </span>
          </div>
        </div>

        {/* Options Selectors */}
        {product.options.map((option) => {
          if (option.name === 'Title' && option.values.length === 1 && option.values[0] === 'Default Title') {
            return null;
          }

          // Check if variants have UNIQUE images (not just the same default product image)
          const variantImagesForOption = option.values.map(value => {
            const variant = product.variants.edges.find(({ node }) =>
              node.selectedOptions.some(opt => opt.name === option.name && opt.value === value)
            )?.node;
            return variant?.image?.url || null;
          });
          const uniqueImages = new Set(variantImagesForOption.filter(Boolean));
          const hasVariantImages = uniqueImages.size > 1;

          // Show swatch UI if variants have unique images registered
          const showSwatchUI = hasVariantImages;

          // Check availability for each option value
          const getVariantForOption = (optionValue: string) => {
            const testOptions = { ...selectedOptions, [option.name]: optionValue };
            return product.variants.edges.find(({ node }) => {
              return node.selectedOptions.every(
                opt => testOptions[opt.name] === opt.value
              );
            })?.node;
          };

          // Get variant image for a specific option value
          const getVariantImageForOption = (optionValue: string) => {
            const variant = product.variants.edges.find(({ node }) =>
              node.selectedOptions.some(opt => opt.name === option.name && opt.value === optionValue)
            )?.node;
            return variant?.image?.url || null;
          };

          return (
            <div key={option.name} className="mb-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{option.name}:</span>
                  <span className="text-sm font-medium text-foreground">{selectedOptions[option.name]}</span>
                </div>
                {showSwatchUI && (
                  <span className="text-base font-semibold text-foreground">
                    {formatPrice(price.amount, price.currencyCode)}
                  </span>
                )}
              </div>

              {showSwatchUI ? (
                // Color swatches - square cards with variant images and labels
                <div className="flex flex-wrap gap-3">
                  {option.values.map((value) => {
                    const variant = getVariantForOption(value);
                    const isAvailable = variant?.availableForSale ?? true;
                    const isSelected = selectedOptions[option.name] === value;
                    const variantImage = getVariantImageForOption(value);

                    const colorMap: Record<string, string> = {
                      'black': '#000000', 'white': '#FFFFFF', 'red': '#EF4444',
                      'blue': '#3B82F6', 'green': '#22C55E', 'yellow': '#EAB308',
                      'pink': '#EC4899', 'purple': '#A855F7', 'orange': '#F97316',
                      'brown': '#92400E', 'gray': '#6B7280', 'grey': '#6B7280',
                      'navy': '#1E3A5A', 'beige': '#D4C4A8', 'cream': '#FFFDD0',
                    };
                    const bgColor = colorMap[value.toLowerCase()] || '#9CA3AF';

                    return (
                      <button
                        key={value}
                        onClick={() => handleOptionChange(option.name, value)}
                        disabled={!isAvailable}
                        className={cn(
                          "flex flex-col items-center gap-1 transition-all",
                          !isAvailable && "opacity-40 cursor-not-allowed"
                        )}
                        title={value}
                      >
                        <div className={cn(
                          "w-20 h-20 rounded-lg border-2 relative flex items-center justify-center overflow-hidden",
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
                            <div className="absolute top-1 right-1 bg-foreground rounded-full p-0.5">
                              <Check className="h-3 w-3 text-background" />
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
                // Size/other options - text buttons with availability status
                <div className="space-y-2">
                  {!product.variants.edges.every(v => v.node.availableForSale) && (
                    <p className="text-xs text-destructive font-medium">
                      {product.variants.edges.some(v => v.node.availableForSale) ? t('product.someSizesUnavailable') : t('product.soldOut')}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {option.values.map((value) => {
                      const variant = getVariantForOption(value);
                      const isAvailable = variant?.availableForSale ?? true;
                      const isSelected = selectedOptions[option.name] === value;

                      return (
                        <button
                          key={value}
                          onClick={() => handleOptionChange(option.name, value)}
                          disabled={!isAvailable}
                          className={cn(
                            "min-w-[48px] py-2 px-4 text-sm font-medium transition-all relative",
                            isSelected
                              ? "text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                            !isAvailable && "line-through opacity-50 cursor-not-allowed"
                          )}
                        >
                          {value}
                          {isSelected && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Quantity */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-foreground">{t('product.quantity')}</h3>
            {maxQuantity !== null && maxQuantity < 99 && (
              <span className="text-xs text-muted-foreground">
                {maxQuantity} available
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              disabled={quantity <= 1}
              className="w-10 h-10 rounded-lg border border-border flex items-center justify-center hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-12 text-center font-semibold text-foreground" translate="no">{quantity}</span>
            <button
              onClick={() => setQuantity(Math.min(maxQuantity, quantity + 1))}
              disabled={quantity >= maxQuantity}
              className="w-10 h-10 rounded-lg border border-border flex items-center justify-center hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Trust Badges */}
        <div className="flex gap-6 mb-6 py-4 border-y border-border justify-center">
          <div className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs font-medium text-foreground">{t('product.shippingBenefit')}</p>
              <p className="text-[10px] text-muted-foreground">{t('product.shippingBenefitDesc')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs font-medium text-foreground">{t('product.qualityGuarantee')}</p>
              <p className="text-[10px] text-muted-foreground">{t('product.qualityGuaranteeDesc')}</p>
            </div>
          </div>
        </div>

        {/* Description */}
        {(product.descriptionHtml || product.description) && (
          <div className="mb-6">
            {product.descriptionHtml ? (
              <div
                className="prose prose-sm max-w-none text-muted-foreground overflow-x-hidden
                  prose-headings:text-foreground prose-headings:font-bold prose-headings:mt-4 prose-headings:mb-2
                  prose-h1:text-xl prose-h2:text-lg prose-h3:text-base
                  prose-p:leading-relaxed prose-p:mb-3
                  prose-strong:text-foreground prose-strong:font-semibold
                  prose-ul:list-disc prose-ul:pl-5 prose-ul:space-y-1
                  prose-ol:list-decimal prose-ol:pl-5 prose-ol:space-y-1
                  prose-li:text-muted-foreground
                  prose-a:text-primary prose-a:underline hover:prose-a:text-primary/80
                  prose-img:max-w-full prose-img:h-auto prose-img:rounded-lg
                  [&_img]:max-w-full [&_img]:h-auto [&_img]:block
                  [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:block
                  [&_pre]:max-w-full [&_pre]:overflow-x-auto
                  [&_iframe]:max-w-full [&_*]:max-w-full"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(product.descriptionHtml) }}
              />
            ) : (
              <p className="text-sm text-muted-foreground leading-relaxed">{product.description}</p>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <Footer />

      {/* Fixed Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border p-4" translate="no">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          {/* Wishlist Button */}
          <button
            onClick={() => {
              const wishlisted = isWishlisted(product.id);
              toggleWishlist({
                productId: product.id,
                handle: product.handle,
                title: product.title,
                imageUrl: product.images.edges[0]?.node.url,
                price: price.amount,
                currencyCode: price.currencyCode,
              });
              toast.success(wishlisted ? '찜 목록에서 제거했습니다.' : '찜 목록에 추가했습니다.', {
                position: 'top-center',
              });
            }}
            className={cn(
              "w-12 h-12 rounded-lg border flex items-center justify-center flex-shrink-0 transition-colors",
              isWishlisted(product.id)
                ? "border-red-400 bg-red-50 text-red-500"
                : "border-border text-muted-foreground hover:border-red-400 hover:text-red-500"
            )}
          >
            <Heart
              className={cn(
                "h-5 w-5 transition-colors",
                isWishlisted(product.id) ? "fill-red-500 text-red-500" : ""
              )}
            />
          </button>
          <Button
            onClick={handleAddToCart}
            disabled={!selectedVariant?.availableForSale}
            variant="outline"
            className="flex-1 h-12 font-semibold border-primary text-primary hover:bg-primary/10"
          >
            <ShoppingCart className="h-5 w-5 mr-2" />
            {selectedVariant?.availableForSale ? t('product.addToCart') : t('product.outOfStock')}
          </Button>
          <Button
            onClick={handleBuyNow}
            disabled={!selectedVariant?.availableForSale || isBuyingNow}
            className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 h-12 font-semibold"
          >
            {isBuyingNow ? '処理中...' : 'すぐ購入'}
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}
