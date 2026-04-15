import { Phone, Mail } from "lucide-react";
import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer className="bg-muted/50 border-t border-border mt-auto">
      <div className="container mx-auto px-4 py-6">
        <div className="space-y-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">カスタマーサポート</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="flex items-center gap-1.5">
              <Phone className="h-4 w-4 text-primary" />
              <a href="tel:0368683009" className="hover:text-primary transition-colors">
                03-6868-3009
              </a>
            </span>
            <span className="flex items-center gap-1.5">
              <Mail className="h-4 w-4 text-primary" />
              <a href="mailto:japan@biteme.co.kr" className="hover:text-primary transition-colors">
                japan@biteme.co.kr
              </a>
            </span>
          </div>
          <div className="flex gap-4 pt-2 border-t border-border/50 text-xs">
            <Link to="/privacy" className="hover:text-primary transition-colors">
              プライバシーポリシー
            </Link>
            <Link to="/terms" className="hover:text-primary transition-colors">
              利用規約
            </Link>
            <Link to="/contact" className="hover:text-primary transition-colors">
              お問い合わせ
            </Link>
          </div>
          <p className="text-xs text-muted-foreground/60">© 2026 BITE ME JAPAN. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
