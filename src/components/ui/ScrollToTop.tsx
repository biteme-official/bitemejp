import { ChevronUp } from 'lucide-react';

export function ScrollToTop() {
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-40 right-7 z-50 w-10 h-10 rounded-full bg-primary/80 text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary transition-colors"
      aria-label="Scroll to top"
    >
      <ChevronUp className="h-5 w-5" />
    </button>
  );
}
