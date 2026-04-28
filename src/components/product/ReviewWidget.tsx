import { useState, useEffect } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Review {
  id: number;
  title: string;
  body: string;
  rating: number;
  reviewer: { name: string };
  created_at: string;
  has_published_pictures: boolean;
  pictures: Array<{ urls: { original: string } }>;
}

function StarRating({ rating, interactive = false, onChange }: {
  rating: number;
  interactive?: boolean;
  onChange?: (r: number) => void;
}) {
  const [hovered, setHovered] = useState(0);
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`h-4 w-4 ${(hovered || rating) >= s ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground'} ${interactive ? 'cursor-pointer' : ''}`}
          onMouseEnter={() => interactive && setHovered(s)}
          onMouseLeave={() => interactive && setHovered(0)}
          onClick={() => interactive && onChange?.(s)}
        />
      ))}
    </div>
  );
}

function WriteReviewForm({ productId, onSuccess }: { productId: string; onSuccess: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', rating: 0, title: '', body: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.rating) return setError('評価を選択してください');
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/judgeme-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, ...form }),
      });
      if (!res.ok) throw new Error();
      onSuccess();
    } catch {
      setError('送信に失敗しました。もう一度お試しください。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-secondary/30 rounded-xl p-4">
      <h3 className="text-sm font-semibold">レビューを書く</h3>
      <div>
        <p className="text-xs text-muted-foreground mb-1">評価 *</p>
        <StarRating rating={form.rating} interactive onChange={(r) => setForm(f => ({ ...f, rating: r }))} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">お名前 *</label>
          <input
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="w-full mt-1 px-3 py-2 text-sm rounded-lg border border-border bg-background"
            placeholder="田中 太郎"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">メールアドレス *</label>
          <input
            required
            type="email"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className="w-full mt-1 px-3 py-2 text-sm rounded-lg border border-border bg-background"
            placeholder="example@email.com"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground">タイトル</label>
        <input
          value={form.title}
          onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          className="w-full mt-1 px-3 py-2 text-sm rounded-lg border border-border bg-background"
          placeholder="一言でまとめると..."
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground">レビュー内容</label>
        <textarea
          value={form.body}
          onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
          rows={4}
          className="w-full mt-1 px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none"
          placeholder="商品の感想を教えてください..."
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? '送信中...' : 'レビューを送信'}
      </Button>
    </form>
  );
}

export function ReviewWidget({ productNumericId }: { productNumericId: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const fetchReviews = async () => {
    try {
      const res = await fetch(`/api/judgeme-reviews?product_id=${productNumericId}`);
      if (!res.ok) return;
      const data = await res.json();
      setReviews(data.reviews || []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!productNumericId) return;
    fetchReviews();
  }, [productNumericId]);

  const avgRating = reviews.length
    ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
    : 0;

  if (loading) return <div className="h-24 animate-pulse bg-secondary rounded-xl" />;

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
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
        {!showForm && !submitted && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            レビューを書く
          </Button>
        )}
      </div>

      {/* 리뷰 작성 폼 */}
      {showForm && !submitted && (
        <WriteReviewForm
          productId={productNumericId}
          onSuccess={() => { setShowForm(false); setSubmitted(true); }}
        />
      )}
      {submitted && (
        <div className="bg-green-50 text-green-700 text-sm rounded-xl p-4 text-center">
          レビューを送信しました！承認後に表示されます。
        </div>
      )}

      {/* 리뷰 목록 */}
      {reviews.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          まだレビューがありません。最初のレビューを書いてみましょう！
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <div key={r.id} className="bg-card rounded-xl border border-border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StarRating rating={r.rating} />
                  <span className="text-sm font-medium">{r.reviewer.name}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })}
                </span>
              </div>
              {r.title && <p className="text-sm font-semibold">{r.title}</p>}
              {r.body && <p className="text-sm text-muted-foreground whitespace-pre-line">{r.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
