/**
 * 어드민 「재입고 알림」 탭 (#221) — 누가 무엇을 신청했고, 알림이 나갔는지.
 *
 * 데이터는 /api/line-restock?view=admin 한 번. 신청(`line_restock_sub`)과 발송(`line_send`)을
 * 서버가 맞춰서, 아직 안 보낸 신청은 지금 재고까지 확인해 상태를 붙여 준다.
 *
 * 발송은 이 화면이 아니라 크론(매시 30분)이 한다. Shopify 에서 재고를 넣으면 다음 30분에 나간다.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Status = "waiting" | "ready" | "sent" | "not_friend" | "gone";

interface Row {
  createdAt: string;
  displayName: string | null;
  userTail: string;
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  status: Status;
  sentAt: string | null;
}

interface RestockAdminData {
  rows: Row[];
  enabled: boolean;
  ttlDays: number;
}

const STATUS: Record<Status, { label: string; className: string }> = {
  waiting: { label: "품절 중", className: "bg-muted text-muted-foreground" },
  ready: { label: "재입고됨 · 발송 대기", className: "bg-amber-100 text-amber-800" },
  sent: { label: "발송 완료", className: "bg-emerald-100 text-emerald-800" },
  not_friend: { label: "친구 아님 · 미도달", className: "bg-red-100 text-red-700" },
  gone: { label: "옵션 삭제됨", className: "bg-muted text-muted-foreground line-through" },
};

async function fetchRestock(secret: string): Promise<RestockAdminData> {
  const res = await fetch("/api/line-restock?view=admin", { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/** JST 기준 「10/08 14:30」 */
function jst(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const productLink = (gid: string) => `/product/${gid.split("/").pop()}`;

function Customer({ r }: { r: Row }) {
  return (
    <span>
      {r.displayName ?? <span className="text-muted-foreground">(이름 모름)</span>}
      <span className="ml-1 font-mono text-[10px] text-muted-foreground">…{r.userTail}</span>
    </span>
  );
}

function Product({ r }: { r: Row }) {
  return (
    <a href={productLink(r.productId)} target="_blank" rel="noopener noreferrer" className="hover:underline">
      {r.productTitle || "(상품명 없음)"}
      {r.variantTitle && <span className="text-muted-foreground"> · {r.variantTitle}</span>}
    </a>
  );
}

export default function RestockTab({ secret }: { secret: string }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["restock-admin", secret],
    queryFn: () => fetchRestock(secret),
    enabled: !!secret,
    staleTime: 60_000,
  });
  const [filter, setFilter] = useState<Status | "all">("all");

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const counts = useMemo(() => {
    const c: Record<Status, number> = { waiting: 0, ready: 0, sent: 0, not_friend: 0, gone: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  // 상품별 — 아직 알림을 기다리는 사람이 많은 옵션부터. 재입고 우선순위 판단용
  const byProduct = useMemo(() => {
    const m = new Map<string, { r: Row; waiting: number; total: number }>();
    for (const r of rows) {
      const cur = m.get(r.variantId) ?? { r, waiting: 0, total: 0 };
      cur.total++;
      if (r.status === "waiting" || r.status === "ready") cur.waiting++;
      m.set(r.variantId, cur);
    }
    return [...m.values()].filter((v) => v.waiting > 0).sort((a, b) => b.waiting - a.waiting);
  }, [rows]);

  const sends = useMemo(
    () => rows.filter((r) => r.sentAt).sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? "")),
    [rows],
  );
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  if (isLoading) return <p className="text-xs text-muted-foreground py-8 text-center">불러오는 중…</p>;
  if (error || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        재입고 알림 목록을 불러오지 못했습니다.
        <p className="text-xs mt-1 text-red-600">{error instanceof Error ? error.message : ""}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "rounded-lg border px-4 py-2.5 text-xs flex flex-wrap items-center gap-x-4 gap-y-1",
          data.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800",
        )}
      >
        <span className="font-semibold">{data.enabled ? "● 자동 발송 켜짐" : "○ 자동 발송 꺼짐 — LINE_RESTOCK_ENABLED 미설정"}</span>
        <span>Shopify 에서 재고를 넣으면 매시 30분에 신청자에게 LINE 이 나갑니다 (21~09시는 다음 날 아침)</span>
        <button
          onClick={() => refetch()}
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> 새로고침
        </button>
      </div>

      {/* 요약 — 누르면 아래 신청 목록이 그 상태로 걸러진다 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["waiting", "ready", "sent", "not_friend"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(filter === s ? "all" : s)}
            className={cn("rounded-lg border bg-card p-3 text-left", filter === s && "ring-2 ring-primary")}
          >
            <p className="text-[11px] text-muted-foreground">{STATUS[s].label}</p>
            <p className="text-2xl font-bold tabular-nums">{counts[s]}<span className="text-xs font-normal ml-0.5">건</span></p>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">기다리는 사람이 많은 옵션</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th:not(.text-right)]:text-left">
                <th>상품 · 옵션</th><th className="text-right">대기</th><th className="text-right">누적 신청</th>
              </tr>
            </thead>
            <tbody>
              {byProduct.length === 0 && (
                <tr><td colSpan={3} className="py-6 text-center text-muted-foreground">기다리는 신청이 없습니다.</td></tr>
              )}
              {byProduct.map(({ r, waiting, total }) => (
                <tr key={r.variantId} className="border-b last:border-0 [&>td]:py-2 [&>td]:pr-3">
                  <td><Product r={r} /></td>
                  <td className="text-right tabular-nums font-semibold">{waiting}명</td>
                  <td className="text-right tabular-nums text-muted-foreground">{total}명</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            신청 목록 <span className="font-normal text-muted-foreground">({shown.length}건{filter !== "all" && ` · ${STATUS[filter].label}`})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th]:text-left">
                <th>신청 (JST)</th><th>고객</th><th>상품 · 옵션</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">신청이 없습니다.</td></tr>
              )}
              {shown.map((r) => (
                <tr key={`${r.userTail}|${r.variantId}|${r.createdAt}`} className="border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top">
                  <td className="whitespace-nowrap tabular-nums">{jst(r.createdAt)}</td>
                  <td><Customer r={r} /></td>
                  <td><Product r={r} /></td>
                  <td><span className={cn("rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap", STATUS[r.status].className)}>{STATUS[r.status].label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">발송 목록 <span className="font-normal text-muted-foreground">({sends.length}건)</span></CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th]:text-left">
                <th>발송 (JST)</th><th>고객</th><th>상품 · 옵션</th><th>결과</th><th>신청 (JST)</th>
              </tr>
            </thead>
            <tbody>
              {sends.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">아직 나간 알림이 없습니다.</td></tr>
              )}
              {sends.map((r) => (
                <tr key={`${r.userTail}|${r.variantId}|${r.createdAt}`} className="border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top">
                  <td className="whitespace-nowrap tabular-nums">{jst(r.sentAt)}</td>
                  <td><Customer r={r} /></td>
                  <td><Product r={r} /></td>
                  <td><span className={cn("rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap", STATUS[r.status].className)}>{STATUS[r.status].label}</span></td>
                  <td className="whitespace-nowrap tabular-nums text-muted-foreground">{jst(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        최근 {data.ttlDays}일 신청 기준 · 같은 사람이 같은 옵션을 여러 번 누르면 한 건 · 고객 이름은 LINE 공식계정 친구일 때만 보입니다
      </p>
    </div>
  );
}
