import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { fetchProductById } from '@/lib/shopify';
import { useCartStore, type CartItem } from '@/stores/cartStore';

/**
 * /cart/restore — LINE 담기 이탈 저니의 복구 링크가 도착하는 곳.
 *
 * 우리 카트는 브라우저(zustand + localStorage)에 있어서 Shopify 복구 URL 같은 게 없다.
 * 그래서 저니가 `?c=<상품id>:<옵션id>:<수량>,...` 를 실어 보내고 여기서 되살린다.
 *
 * 서명하지 않는다. 이 링크로 할 수 있는 일은 **자기 브라우저의 자기 카트를 채우는 것**뿐이라
 * (Shopify 의 공개 카트 퍼머링크와 같은 성격) 위조해서 얻을 게 없다. 대신 형식이 어긋난
 * 값은 조용히 버리고, 되살린 뒤에는 사용자가 카트를 눈으로 확인하고 진행하게 둔다 —
 * 결제창으로 바로 밀어 넣지 않는다.
 *
 * 이미 담겨 있는 상품은 건드리지 않는다. 링크를 두 번 눌렀다고 수량이 두 배가 되면 안 된다.
 */
type Parsed = { productId: string; variantId: string; quantity: number };

function parse(c: string | null): Parsed[] {
  if (!c) return [];
  const out: Parsed[] = [];
  for (const part of c.split(',').slice(0, 20)) {
    const [p, v, q] = part.split(':');
    if (!/^\d+$/.test(p ?? '') || !/^\d+$/.test(v ?? '')) continue;
    const n = Number(q);
    if (!Number.isFinite(n) || n < 1 || n > 99) continue;
    out.push({ productId: p, variantId: v, quantity: Math.floor(n) });
  }
  return out;
}

export default function CartRestore() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // React 18 StrictMode 는 이펙트를 두 번 태운다 — 수량이 두 배가 되지 않도록 한 번만 돈다
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const wanted = parse(searchParams.get('c'));
    if (wanted.length === 0) {
      navigate('/', { replace: true });
      return;
    }

    void (async () => {
      const { items, addItem } = useCartStore.getState();
      const already = new Set(items.map(i => i.variantId));
      let restored = 0;

      for (const w of wanted) {
        const variantGid = `gid://shopify/ProductVariant/${w.variantId}`;
        if (already.has(variantGid)) { restored++; continue; }

        const node = await fetchProductById(w.productId).catch(() => null);
        if (!node) continue;
        const variant = node.variants.edges.find(e => e.node.id === variantGid)?.node;
        // 품절·삭제된 옵션은 조용히 건너뛴다. 하나 빠졌다고 나머지까지 못 살릴 이유가 없다.
        if (!variant) continue;

        const item: CartItem = {
          product: { node },
          variantId: variant.id,
          variantTitle: variant.title,
          price: variant.price,
          quantity: w.quantity,
          quantityAvailable: variant.quantityAvailable ?? null,
          selectedOptions: variant.selectedOptions,
        };
        addItem(item);
        restored++;
      }

      if (restored === 0) { setFailed(true); return; }
      // 카트 서랍은 헤더가 열고 닫는다. 되살린 카트를 눈으로 확인하도록 결제 페이지로 보낸다.
      navigate('/checkout', { replace: true });
    })();
  }, [navigate, searchParams]);

  if (failed) {
    return (
      <div className="min-h-[50vh] flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-gray-800">カートを復元できませんでした。</p>
        <p className="text-xs text-gray-500">商品が売り切れているか、販売を終了した可能性があります。</p>
        <button onClick={() => navigate('/', { replace: true })} className="mt-2 text-sm underline">
          ショップへ戻る
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center gap-3 text-gray-500">
      <Loader2 className="w-5 h-5 animate-spin" />
      <p className="text-sm">カートを準備しています…</p>
    </div>
  );
}
