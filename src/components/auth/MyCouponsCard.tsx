/**
 * 마이페이지 「保有クーポン」 카드 — 웰컴(WELCOME10·LINKUP10)과 블프 LINE 5%.
 *
 * 쿠폰은 결제 때 자동으로 붙어(cartStore.createCheckout) 고객이 코드를 넣지 않는다. 그래서 코드는 안 보여주고
 * 받았는지·썼는지만 보여준다. 판정이 안 되는 쿠폰은 「사용 가능」으로 보이지 않게 줄을 숨긴다.
 * 웰컴은 cartStore 가 쓰는 것과 같은 저장값을 본다 — 저장값이 없으면 결제에도 안 붙으므로 보여주지 않는다.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ticket } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { BF_APPLY_END, BF_PERCENT, getBfCouponStatus, type BfCouponStatus } from '@/lib/bfCoupon';
import { LINE_WELCOME_DISCOUNT_KEY, LINE_WELCOME_DISCOUNT_LABEL } from '@/lib/lineWelcomeDiscount';
import { useWelcomeCouponStatus } from '@/lib/welcomeCouponStatus';

function readWelcomeCode(): string | null {
  try {
    return localStorage.getItem(LINE_WELCOME_DISCOUNT_KEY);
  } catch {
    return null;
  }
}

function CouponRow({ title, note, used, action }: {
  title: string; note: string; used?: boolean; action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${used ? 'text-muted-foreground' : ''}`}>{title}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{note}</p>
      </div>
      {action ? (
        <button
          onClick={action.onClick}
          className="shrink-0 h-8 px-3 rounded-lg bg-[#06C755] text-white text-xs font-semibold hover:opacity-90"
        >
          {action.label}
        </button>
      ) : (
        <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full ${used ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-700'}`}>
          {used ? '利用済み' : '利用可能'}
        </span>
      )}
    </div>
  );
}

export function MyCouponsCard() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.user?.lineSessionToken);
  const [welcomeCode] = useState(readWelcomeCode);
  const welcome = useWelcomeCouponStatus(welcomeCode, token);
  const [bf, setBf] = useState<BfCouponStatus>('unknown');

  useEffect(() => {
    if (!token || Date.now() > BF_APPLY_END) return;
    let alive = true;
    void getBfCouponStatus(token).then((v) => { if (alive) setBf(v); });
    return () => { alive = false; };
  }, [token]);

  if (welcome === 'unknown' && bf === 'unknown') return null;

  const bfTitle = `ブラックフライデー LINE友だち ${BF_PERCENT}%OFF`;
  const bfPeriod = '有効期間 11/9(月)〜11/22(日)';

  return (
    <div className="bg-card rounded-xl border border-border p-5">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Ticket className="h-4 w-4 text-muted-foreground" />
        保有クーポン
      </h3>
      <div className="mt-1 divide-y divide-border">
        {welcome !== 'unknown' && (
          <CouponRow
            title={`LINE会員クーポン ${LINE_WELCOME_DISCOUNT_LABEL}`}
            note="お一人さま1回限り"
            used={welcome === 'used'}
          />
        )}
        {bf === 'unclaimed' && (
          <CouponRow title={bfTitle} note={bfPeriod} action={{ label: '受け取る', onClick: () => navigate('/bf') }} />
        )}
        {(bf === 'available' || bf === 'used') && (
          <CouponRow title={bfTitle} note={bfPeriod} used={bf === 'used'} />
        )}
      </div>
      <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
        {welcome === 'unused' && bf === 'available' && (
          <p>※両方お持ちの場合は、割引が大きいLINE会員クーポンが先に適用されます。</p>
        )}
        <p>※クーポンはお支払い時に自動で適用されます（1回のご注文につき1枚）。パートナーの割引コードをお持ちの場合は、そちらが優先されます。</p>
      </div>
    </div>
  );
}
