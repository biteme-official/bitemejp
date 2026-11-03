/**
 * 어드민 목록 아래 페이지 번호 (#254) — usePaged 와 한 쌍.
 * 한 페이지로 끝나면 아무것도 그리지 않는다.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Paged } from "@/hooks/usePaged";
import { cn } from "@/lib/utils";

/** 1 … 4 5 [6] 7 8 … 20 — 처음·끝과 현재 주변 두 칸만 */
function pageNumbers(page: number, pages: number): (number | "gap")[] {
  const out: (number | "gap")[] = [];
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 2) out.push(i);
    else if (out[out.length - 1] !== "gap") out.push("gap");
  }
  return out;
}

export default function ListPager<T>({ p }: { p: Paged<T> }) {
  if (p.pages <= 1) return null;
  const from = p.page * p.size + 1;
  const to = Math.min(p.total, from + p.size - 1);
  const btn = "h-7 min-w-7 rounded px-2 text-xs tabular-nums disabled:opacity-40";
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] text-muted-foreground tabular-nums">
        총 {p.total}건 중 {from}–{to}
      </p>
      <div className="flex items-center gap-1">
        <button className={cn(btn, "hover:bg-muted")} disabled={p.page === 0} onClick={() => p.setPage(p.page - 1)} aria-label="이전 페이지">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pageNumbers(p.page, p.pages).map((n, i) =>
          n === "gap" ? (
            <span key={`gap${i}`} className="px-1 text-xs text-muted-foreground">…</span>
          ) : (
            <button
              key={n}
              onClick={() => p.setPage(n)}
              aria-current={n === p.page ? "page" : undefined}
              className={cn(btn, n === p.page ? "bg-foreground text-background font-semibold" : "hover:bg-muted")}
            >
              {n + 1}
            </button>
          ),
        )}
        <button className={cn(btn, "hover:bg-muted")} disabled={p.page >= p.pages - 1} onClick={() => p.setPage(p.page + 1)} aria-label="다음 페이지">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
