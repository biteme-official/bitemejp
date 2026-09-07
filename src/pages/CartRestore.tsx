import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { fetchProductsByVariantIds } from '@/lib/shopify';
import { useCartStore, type CartItem } from '@/stores/cartStore';

/**
 * /r/:c — LINE 담기 이탈 저니의 복구 링크가 도착하는 곳.
 *
 * 우리 카트는 브라우저(zustand + localStorage)에 있어서 Shopify 복구 URL 같은 게 없다.
 * 그래서 저니가 카트를 주소에 실어 보내고 여기서 되살린다.
 *
 *   /r/ifyim7e49~1.ifyisg4zd~2    ← 36진수 옵션id ~ 수량, 마침표로 구분
 *
 * 서명하지 않는다. 이 링크로 할 수 있는 일은 **자기 브라우저의 자기 카트를 채우는 것**뿐이라
 * (Shopify 의 공개 카트 퍼머링크와 같은 성격) 위조해서 얻을 게 없다. 대신 형식이 어긋난
 * 값은 조용히 버리고, 되살린 뒤에는 사용자가 카트를 눈으로 확인하고 진행하게 둔다 —
 * 결제창으로 바로 밀어 넣지 않는다.
 *
 * UTM 은 주소에 없다. `/r/` 로 들어오는 길은 이 저니뿐이라 `index.html` 이 GA4 보다 먼저 심는다.
 *
 * 이미 담겨 있는 상품은 건드리지 않는다. 링크를 두 번 눌렀다고 수량이 두 배가 되면 안 된다.
 */
type Parsed = { variantId: string; quantity: number };

/** 짧은 형식: `<36진수 옵션id>~<수량>` 을 마침표로 이어 붙인 것 */
function parseShort(c: string | undefined): Parsed[] {
  if (!c) return [];
  const out: Parsed[] = [];
  const seen = new Set<string>();
  for (const part of c.split('.').slice(0, 20)) {
    const [b36, q] = part.split('~');
    if (!b36 || !/^[0-9a-z]{1,12}$/.test(b36)) continue;
    // 36진수 → 10진수. 옵션 id 는 14자리라 Number 로는 정밀도가 모자라 BigInt 로 센다.
    const id = [...b36].reduce((n, ch) => n * 36n + BigInt(parseInt(ch, 36)), 0n).toString();
    if (id === '0') continue;
    const n = Number(q);
    if (!Number.isFinite(n) || n < 1 || n > 99) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ variantId: id, quantity: Math.floor(n) });
  }
  return out;
}

/** 옛 형식(`/cart/restore?c=상품:옵션:수량,...`) — 이미 나간 링크가 있으면 계속 열려야 한다 */
function parseLegacy(c: string | null): Parsed[] {
  if (!c) return [];
  const out: Parsed[] = [];
  const seen = new Set<string>();
  for (const part of c.split(',').slice(0, 20)) {
    const bits = part.split(':');
    const v = bits.length >= 3 ? bits[1] : bits[0];
    const q = bits[bits.length - 1];
    if (!/^\d+$/.test(v ?? '')) continue;
    const n = Number(q);
    if (!Number.isFinite(n) || n < 1 || n > 99) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ variantId: v, quantity: Math.floor(n) });
  }
  return out;
}

export default function CartRestore() {
  const { c: pathC } = useParams<{ c: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // React 18 StrictMode 는 이펙트를 두 번 태운다 — 수량이 두 배가 되지 않도록 한 번만 돈다
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const wanted = pathC ? parseShort(pathC) : parseLegacy(searchParams.get('c'));
    if (wanted.length === 0) {
      navigate('/', { replace: true });
      return;
    }

    void (async () => {
      const { items } = useCartStore.getState();
      const already = new Set(items.map(i => i.variantId));
      let restored = 0;

      // 이미 담긴 것은 조회조차 하지 않는다
      const need = wanted.filter(w => !already.has(`gid://shopify/ProductVariant/${w.variantId}`));
      restored += wanted.length - need.length;

      // 한 번에 묶어 부른다 — 담긴 수만큼 왕복하면 링크를 누른 사람이 그만큼 기다린다
      const byVariant = await fetchProductsByVariantIds(
        need.map(w => `gid://shopify/ProductVariant/${w.variantId}`),
      ).catch(() => new Map());

      const rebuilt: CartItem[] = [];
      for (const w of need) {
        const variantGid = `gid://shopify/ProductVariant/${w.variantId}`;
        const node = byVariant.get(variantGid);
        if (!node) continue;
        const variant = node.variants.edges.find(e => e.node.id === variantGid)?.node;
        // 삭제됐거나 품절인 옵션은 건너뛴다. 하나 빠졌다고 나머지까지 못 살릴 이유가 없다.
        //
        // 🔴 품절을 안 거르면 조용히 수량 0 짜리 줄이 생긴다. addItem 이
        //    `Math.min(수량, quantityAvailable)` 로 자르는데 `?? Infinity` 는 null 만
        //    걸러서 0 이 그대로 살아남는다. 그 줄을 들고 결제로 가면 살 수 없다.
        if (!variant || !variant.availableForSale || variant.quantityAvailable === 0) continue;

        rebuilt.push({
          product: { node },
          variantId: variant.id,
          variantTitle: variant.title,
          price: variant.price,
          quantity: Math.min(w.quantity, variant.quantityAvailable ?? w.quantity),
          quantityAvailable: variant.quantityAvailable ?? null,
          selectedOptions: variant.selectedOptions,
        });
        restored++;
      }

      if (restored === 0) { setFailed(true); return; }

      // 🔴 addItem 을 줄마다 부르면 안 된다. addItem 은 매번 syncGiftItem 을 던지는데
      //    그 함수는 재진입 방지 플래그로 앞선 호출이 끝날 때까지 나머지를 통째로
      //    무시한다. 그러면 증정 임계값을 부분 카트로 판정해, 5,000엔을 넘겼는데도
      //    うちわ 없이 결제로 가는 Issue #126 과 같은 손해가 난다.
      //    한 번에 넣고 증정 동기화를 딱 한 번, 끝날 때까지 기다린다.
      if (rebuilt.length > 0) {
        useCartStore.setState({ items: [...useCartStore.getState().items, ...rebuilt] });
        await useCartStore.getState().syncGiftItem();
      }

      // 카트 서랍은 헤더가 열고 닫는다. 되살린 카트를 눈으로 확인하도록 결제 페이지로 보낸다.
      navigate('/checkout', { replace: true });
    })();
  }, [navigate, pathC, searchParams]);

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
