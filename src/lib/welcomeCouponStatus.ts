/**
 * LINE 로그인 보상 쿠폰을 이미 썼는지 서버에 묻는다 (#242).
 *
 * 쿠폰 키(line_welcome_discount)는 로그인할 때마다 저장되고 지워지지 않아, 그것만 보고
 * 할인 줄을 띄우면 이미 쓴 사람에게도 보인다(#236 → #241 로 되돌림). 그래서
 * 「미사용」이 확인됐을 때만 보이게 한다. 조회 실패·판정 불가는 전부 숨김 쪽이다.
 *
 * 한 세션에 한 번만 묻는다 — 장바구니를 열 때마다 Admin 조회가 나가지 않게.
 */
import { useEffect, useState } from "react";

export type CouponUsage = "used" | "unused" | "unknown";

const CACHE_PREFIX = "welcome_coupon_status:";
const inflight = new Map<string, Promise<CouponUsage>>();

async function fetchStatus(code: string, lineSessionToken: string): Promise<CouponUsage> {
  const res = await fetch("/api/customer-orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "coupon-status", lineSessionToken }),
  });
  if (!res.ok) return "unknown";
  const data = await res.json();
  const v = data?.coupons?.[code];
  return v === "used" || v === "unused" ? v : "unknown";
}

export function useWelcomeCouponStatus(code: string | null, lineSessionToken: string | undefined): CouponUsage {
  const key = code && lineSessionToken ? `${CACHE_PREFIX}${code}:${lineSessionToken.slice(-16)}` : null;
  const [status, setStatus] = useState<CouponUsage>(() => {
    if (!key) return "unknown";
    try {
      const v = sessionStorage.getItem(key);
      return v === "used" || v === "unused" ? v : "unknown";
    } catch { return "unknown"; }
  });

  useEffect(() => {
    if (!key || !code || !lineSessionToken || status !== "unknown") return;
    let alive = true;
    let p = inflight.get(key);
    if (!p) {
      p = fetchStatus(code, lineSessionToken).catch(() => "unknown" as const);
      inflight.set(key, p);
    }
    p.then((v) => {
      inflight.delete(key);
      // 실패(unknown)는 캐시하지 않는다 — 다음에 장바구니를 열 때 다시 묻는다
      if (v !== "unknown") { try { sessionStorage.setItem(key, v); } catch { /* 무시 */ } }
      if (alive) setStatus(v);
    });
    return () => { alive = false; };
  }, [key, code, lineSessionToken, status]);

  return status;
}
