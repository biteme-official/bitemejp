import { useState, useEffect } from "react";
import { X } from "lucide-react";

// Mobile: opens LINE app directly, PC: opens LINE add-friend page
const LINE_OA_ID = "621txosw";
const LINE_MOBILE_URL = `https://line.me/R/ti/p/@${LINE_OA_ID}`;
const LINE_PC_URL = `https://page.line.me/?accountId=${LINE_OA_ID}`;

function getLineUrl(): string {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  return isMobile ? LINE_MOBILE_URL : LINE_PC_URL;
}

export function LineFloatingButton() {
  const [showTooltip, setShowTooltip] = useState(false);

  useEffect(() => {
    const dismissed = sessionStorage.getItem("line_tooltip_dismissed");
    if (!dismissed) {
      const timer = setTimeout(() => setShowTooltip(true), 2000);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleClick = () => {
    window.open(getLineUrl(), "_blank", "noopener,noreferrer");
  };

  const dismissTooltip = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowTooltip(false);
    sessionStorage.setItem("line_tooltip_dismissed", "1");
  };

  return (
    <div className="fixed bottom-20 right-4 z-40 flex items-end gap-2">
      {/* Coupon tooltip */}
      {showTooltip && (
        <div
          onClick={handleClick}
          className="bg-foreground text-background rounded-xl px-3 py-2 shadow-lg max-w-[180px] cursor-pointer animate-fade-up relative"
        >
          <button
            onClick={dismissTooltip}
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-muted-foreground/80 flex items-center justify-center"
          >
            <X className="h-3 w-3 text-background" />
          </button>
          <p className="text-xs font-bold leading-tight">
            LINE友だち追加で
            <span className="text-green-400"> 10%OFF </span>
            クーポンプレゼント!
          </p>
          {/* Arrow pointing right */}
          <div className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[6px] border-l-foreground" />
        </div>
      )}

      {/* LINE button */}
      <button
        onClick={handleClick}
        className="flex items-center justify-center w-14 h-14 rounded-full shadow-lg hover:scale-110 transition-transform cursor-pointer flex-shrink-0"
        style={{ backgroundColor: "#06C755" }}
        aria-label="LINEでお問い合わせ"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 120 120"
          className="w-8 h-8"
          fill="white"
        >
          <path d="M60 0C26.9 0 0 22.5 0 50.2c0 24.8 22 45.6 51.7 49.5 2 .4 4.7 1.3 5.4 3 .6 1.5.4 3.8.2 5.3l-.9 5.2c-.3 1.5-1.2 5.9 5.1 3.2s34.1-20.1 46.5-34.4C118.5 70.2 120 60.5 120 50.2 120 22.5 93.1 0 60 0zM35.4 65.2a1.9 1.9 0 01-1.9 1.9h-15a1.9 1.9 0 01-1.9-1.9V38.8a1.9 1.9 0 011.9-1.9h3.6a1.9 1.9 0 011.9 1.9v22.8h9.5a1.9 1.9 0 011.9 1.9v3.6zm8.6 0a1.9 1.9 0 01-1.9 1.9H38.5a1.9 1.9 0 01-1.9-1.9V38.8a1.9 1.9 0 011.9-1.9h3.6a1.9 1.9 0 011.9 1.9v26.4zm30.5 0a1.9 1.9 0 01-1.9 1.9h-3.6a1.9 1.9 0 01-1.5-.8l-10.8-14.6v13.5a1.9 1.9 0 01-1.9 1.9H51.2a1.9 1.9 0 01-1.9-1.9V38.8a1.9 1.9 0 011.9-1.9h3.6c.6 0 1.2.3 1.5.8L67 52.3V38.8a1.9 1.9 0 011.9-1.9h3.6a1.9 1.9 0 011.9 1.9v26.4zm27.6-22.8a1.9 1.9 0 01-1.9 1.9h-9.5v5h9.5a1.9 1.9 0 011.9 1.9v3.6a1.9 1.9 0 01-1.9 1.9h-9.5v5h9.5a1.9 1.9 0 011.9 1.9v3.6a1.9 1.9 0 01-1.9 1.9h-15a1.9 1.9 0 01-1.9-1.9V38.8a1.9 1.9 0 011.9-1.9h15a1.9 1.9 0 011.9 1.9v3.6z" />
        </svg>
        <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-white text-[10px] font-bold">
          1
        </span>
      </button>
    </div>
  );
}
