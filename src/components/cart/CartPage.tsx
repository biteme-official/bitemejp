import { ChevronLeft, ShoppingBag, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface CartPageProps {
  onBack: () => void;
}

export function CartPage({ onBack }: CartPageProps) {
  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border">
        <div className="flex items-center px-4 h-14">
          <button onClick={onBack} className="p-2 -ml-2 text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="flex-1 text-center font-semibold text-foreground">Shopping Cart</h1>
          <div className="w-9" />
        </div>
      </header>

      {/* Promo Banner */}
      <div className="mx-4 mt-3 bg-accent rounded-xl p-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-secondary rounded-lg flex items-center justify-center">
            <Tag className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground">Add $15 for Free Shipping</p>
            <p className="text-xs text-muted-foreground">You're almost there!</p>
          </div>
        </div>
        <Button
          variant="default"
          size="sm"
          className="bg-primary text-primary-foreground rounded-lg text-xs font-semibold"
        >
          Add Items
        </Button>
      </div>

      {/* Select All */}
      <div className="flex items-center justify-between px-4 py-3 mt-3 bg-card border-y border-border">
        <div className="flex items-center gap-3">
          <Checkbox id="select-all" className="border-primary data-[state=checked]:bg-primary" />
          <label htmlFor="select-all" className="text-sm font-medium text-foreground">
            Select All
          </label>
        </div>
        <Button variant="outline" size="sm" className="text-xs">
          Remove All
        </Button>
      </div>

      {/* Empty Cart State */}
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-24 h-24 bg-muted rounded-full flex items-center justify-center mb-4">
          <ShoppingBag className="h-10 w-10 text-muted-foreground" />
        </div>
        <p className="text-muted-foreground text-sm">Your cart is empty</p>
        <p className="text-muted-foreground text-xs mt-1">Add items to get started</p>
      </div>

      {/* Cart Summary */}
      <div className="fixed bottom-16 left-0 right-0 bg-card border-t border-border">
        <div className="px-4 py-3 space-y-2 max-w-lg mx-auto">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="font-medium text-foreground">$0.00</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Shipping</span>
            <span className="font-medium text-foreground">$0.00</span>
          </div>
          <div className="flex justify-between text-base pt-2 border-t border-border">
            <span className="text-foreground">Total</span>
            <span className="font-bold text-primary">$0.00</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="px-4 pb-4 max-w-lg mx-auto">
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold">
            Proceed to Checkout
          </Button>
        </div>
      </div>
    </div>
  );
}
