import { useState, useEffect } from 'react';
import { Star } from 'lucide-react';

interface Review {
  id: string;
  rating: number;
  name: string;
  content: string;
  content_ja?: string;
  date: string;
  images: string[];
  /** judgeme = 일본몰 고객이 직접 작성 / 미지정 = 한국몰 수집 리뷰 */
  source?: 'judgeme';
  verified?: boolean;
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`h-4 w-4 ${rating >= s ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground'}`}
        />
      ))}
    </div>
  );
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
}

const PER_PAGE = 5;

export function ReviewWidget({ productNumericId, onCount }: { productNumericId: string; onCount?: (n: number) => void }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!productNumericId) return;

    // Judge.me 는 외부 API 라 지연될 수 있다. 한 쪽이 늦어도 다른 쪽 리뷰는
    // 보여야 하므로 타임아웃을 두고 실패 시 빈 배열로 degrade 한다.
    const load = (path: string, timeoutMs = 5000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      return fetch(`${path}?shopify_product_id=${productNumericId}`, { signal: ctrl.signal })
        .then(r => (r.ok ? r.json() : { reviews: [] }))
        .then(d => (d.reviews || []) as Review[])
        .catch(() => [] as Review[])
        .finally(() => clearTimeout(timer));
    };

    Promise.all([load('/api/judgeme-reviews'), load('/api/kr-reviews')])
      .then(([own, kr]) => {
        // 일본몰 고객이 직접 쓴 리뷰를 최신순으로 먼저, 그 뒤에 한국몰 수집 리뷰(별점순)
        const list = [
          ...own.slice().sort((a, b) => b.date.localeCompare(a.date)),
          ...kr.slice().sort((a, b) => b.rating - a.rating),
        ];
        setReviews(list);
        onCount?.(list.length);
      })
      .finally(() => setLoading(false));
  }, [productNumericId]);

  const avgRating = reviews.length
    ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
    : 0;

  const totalPages = Math.ceil(reviews.length / PER_PAGE);
  const paged = reviews.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  if (loading) return <div className="h-24 animate-pulse bg-secondary rounded-xl" />;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">カスタマーレビュー</h2>
        {reviews.length > 0 && (
          <div className="flex items-center gap-2 mt-1">
            <StarRating rating={Math.round(avgRating)} />
            <span className="text-sm text-muted-foreground">
              {avgRating.toFixed(1)} / 5（{reviews.length}件）
            </span>
          </div>
        )}
      </div>

      {reviews.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          まだレビューがありません
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {paged.map((r) => (
              <div key={r.id} className="bg-card rounded-xl border border-border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StarRating rating={r.rating} />
                    {r.verified && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                        購入者
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDate(r.date)}</span>
                </div>
                {(r.content_ja || r.content) && (
                  <p className="text-sm text-muted-foreground whitespace-pre-line">{r.content_ja || r.content}</p>
                )}
                {r.images.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {r.images.map((src, i) => (
                      <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                        <img
                          src={src}
                          alt={`レビュー画像 ${i + 1}`}
                          className="h-20 w-20 object-cover rounded-lg border border-border"
                        />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1 pt-2 flex-wrap">
              <button
                onClick={() => setPage(1)}
                disabled={page === 1}
                className="px-3 py-1 text-sm rounded-lg border border-border disabled:opacity-30 hover:bg-secondary transition-colors"
              >
                «
              </button>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-sm rounded-lg border border-border disabled:opacity-30 hover:bg-secondary transition-colors"
              >
                ‹
              </button>
              {(() => {
                const groupStart = Math.floor((page - 1) / 5) * 5 + 1;
                const groupEnd = Math.min(totalPages, groupStart + 4);
                return Array.from({ length: groupEnd - groupStart + 1 }, (_, i) => groupStart + i).map(n => (
                  <button
                    key={n}
                    onClick={() => setPage(n)}
                    className={`px-3 py-1 text-sm rounded-lg border transition-colors ${
                      n === page
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border hover:bg-secondary'
                    }`}
                  >
                    {n}
                  </button>
                ));
              })()}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 text-sm rounded-lg border border-border disabled:opacity-30 hover:bg-secondary transition-colors"
              >
                ›
              </button>
              <button
                onClick={() => setPage(totalPages)}
                disabled={page === totalPages}
                className="px-3 py-1 text-sm rounded-lg border border-border disabled:opacity-30 hover:bg-secondary transition-colors"
              >
                »
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
