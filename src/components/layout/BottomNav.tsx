import { Home, ShoppingCart, Heart, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";

interface NavItem {
  icon: React.ReactNode;
  labelKey: string;
  href: string;
  isActive?: boolean;
}

interface BottomNavProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  const { t } = useTranslation();

  const navItems: NavItem[] = [
    { icon: <Home className="h-5 w-5" />, labelKey: "nav.shop", href: "home" },
    { icon: <ShoppingCart className="h-5 w-5" />, labelKey: "nav.cart", href: "cart" },
    { icon: <Heart className="h-5 w-5" />, labelKey: "nav.favorites", href: "wishlist" },
    { icon: <User className="h-5 w-5" />, labelKey: "nav.account", href: "my" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border safe-area-pb">
      <div className="flex items-center justify-around h-16 max-w-lg mx-auto">
        {navItems.map((item) => (
          <button
            key={item.href}
            onClick={() => onTabChange(item.href)}
            className={cn(
              "flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors",
              activeTab === item.href
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {item.icon}
            <span className="text-xs font-medium">{t(item.labelKey)}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
