import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from "recharts";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";

// ─── 상품명 자동번역 (일어 → 한국어, 어드민 전용) ───────────────────────────
// MyMemory 무료 API 사용. 실제 사이트(biteme.co.jp)에는 영향 없음.
const translationCache = new Map<string, string>();

async function translateBatch(titles: string[]): Promise<Map<string, string>> {
  const uncached = [...new Set(titles)].filter((t) => t && !translationCache.has(t));
  await Promise.all(
    uncached.map(async (title) => {
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=ko&dt=t&q=${encodeURIComponent(title)}`;
        const res = await fetch(url);
        const json = await res.json();
        // 응답 형식: [[["번역된텍스트","원본",...], ...], ...]
        const translated = (json[0] as [string, string][])?.map((seg) => seg[0]).join("") ?? title;
        translationCache.set(title, translated || title);
      } catch {
        translationCache.set(title, title);
      }
    })
  );
  return translationCache;
}

function translateTitle(title: string): string {
  return translationCache.get(title) ?? title;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Range = "today" | "7d" | "28d" | "90d" | "custom";

interface ShopifyData {
  summary: { totalOrders: number; totalRevenue: number; averageOrderValue: number; totalItemsSold: number };
  dailyOrders: { date: string; orders: number; revenue: number }[];
  topProducts: { productId: string; title: string; quantity: number; revenue: number }[];
  lowStock: { title: string; variant: string; quantity: number }[];
}

interface AnalyticsData {
  overview: {
    sessions?: number; activeUsers?: number; newUsers?: number;
    bounceRate?: number; averageSessionDuration?: number;
    purchaseRevenue?: number; transactions?: number;
  };
  funnel: { eventName: string; eventCount: number }[];
  revenueOverTime: { date: string; purchaseRevenue: number; transactions: number; sessions: number; activeUsers: number; itemsViewed: number }[];
  topPages: { pagePath: string; screenPageViews: number; activeUsers: number; averageSessionDuration: number }[];
  trafficSources: { sessionSource: string; sessionMedium: string; sessions: number; activeUsers: number; transactions: number; purchaseRevenue: number }[];
  trafficSourcesOverTime: { date: string; sessionSource: string; sessionMedium: string; sessions: number; activeUsers: number }[];
  devices: { deviceCategory: string; sessions: number }[];
  itemViews: { itemName: string; itemsViewed: number; itemsAddedToCart: number }[];
  exitPages: { pagePath: string; sessions: number; bounceRate: number; screenPageViews: number; averageSessionDuration: number }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BRAND = "#f85a24";
const PALETTE = ["#f85a24", "#fb8c5a", "#fdb997", "#94a3b8", "#cbd5e1"];

function formatDuration(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}
function formatRevenue(v: number) {
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}
function ga4DateToISO(raw: string) {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}
function isoToLabel(iso: string) {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

// GA4 sessions/activeUsers + Shopify orders/revenue를 날짜 기준으로 합침
function buildTimeline(
  ga4: AnalyticsData["revenueOverTime"],
  shopify: ShopifyData["dailyOrders"]
) {
  const map = new Map<string, { date: string; isoDate: string; sessions: number; activeUsers: number; itemViews: number; orders: number; revenue: number }>();
  for (const d of shopify) {
    map.set(d.date, { date: isoToLabel(d.date), isoDate: d.date, sessions: 0, activeUsers: 0, itemViews: 0, orders: d.orders, revenue: d.revenue });
  }
  for (const d of ga4) {
    const key = ga4DateToISO(d.date);
    const ex = map.get(key) ?? { date: isoToLabel(key), isoDate: key, sessions: 0, activeUsers: 0, itemViews: 0, orders: 0, revenue: 0 };
    ex.sessions = d.sessions;
    ex.activeUsers = d.activeUsers ?? 0;
    ex.itemViews = d.itemsViewed ?? 0;
    map.set(key, ex);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

const FUNNEL_ORDER = ["view_item", "add_to_cart", "begin_checkout", "purchase"] as const;

// ─── API ──────────────────────────────────────────────────────────────────────

async function fetchAnalytics(range: Range, secret: string, customFrom?: string, customTo?: string): Promise<AnalyticsData> {
  const params = new URLSearchParams({ range });
  if (range === "custom" && customFrom && customTo) { params.set("from", customFrom); params.set("to", customTo); }
  const res = await fetch(`/api/analytics?${params}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "GA4 오류"); }
  return res.json();
}

async function fetchShopify(range: Range, secret: string, customFrom?: string, customTo?: string): Promise<ShopifyData> {
  const params = new URLSearchParams({ range });
  if (range === "custom" && customFrom && customTo) { params.set("from", customFrom); params.set("to", customTo); }
  const res = await fetch(`/api/shopify-analytics?${params}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "Shopify 오류"); }
  return res.json();
}

// ─── 공통 컴포넌트 ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-semibold text-muted-foreground tracking-widest uppercase">{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <Card className={accent ? "border-orange-200 bg-orange-50/40" : ""}>
      <CardContent className="pt-4 pb-3">
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        <p className={`text-2xl font-bold tracking-tight ${accent ? "text-orange-600" : ""}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ─── 통합 트래픽·매출 차트 ────────────────────────────────────────────────────

function CombinedChart({ timeline }: { timeline: ReturnType<typeof buildTimeline> }) {
  const interval = Math.max(0, Math.ceil(timeline.length / 10) - 1);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">트래픽 · 주문 · 매출 추이</CardTitle>
        <p className="text-xs text-muted-foreground">매출(막대) / 총 사용자(주황선) / 주문수(회색선)</p>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={timeline} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={interval} />
            <YAxis yAxisId="rev" tick={{ fontSize: 10 }} tickFormatter={(v) => `¥${(v / 1000).toFixed(0)}k`} width={48} />
            <YAxis yAxisId="sess" orientation="right" tick={{ fontSize: 10 }} width={36} />
            <Tooltip
              formatter={(value: number, name: string) => {
                if (name === "revenue") return [formatRevenue(value), "매출"];
                if (name === "activeUsers") return [value.toLocaleString(), "총 사용자"];
                return [value, "주문 수"];
              }}
            />
            <Legend
              formatter={(v) => v === "revenue" ? "매출" : v === "activeUsers" ? "총 사용자" : "주문 수"}
              wrapperStyle={{ fontSize: 11 }}
            />
            <Bar yAxisId="rev" dataKey="revenue" fill={BRAND} opacity={0.25} radius={[2, 2, 0, 0]} />
            <Line yAxisId="sess" type="monotone" dataKey="activeUsers" stroke={BRAND} strokeWidth={2.5} dot={false} />
            <Line yAxisId="sess" type="monotone" dataKey="orders" stroke="#94a3b8" strokeWidth={1.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ─── 일자별 데이터 표 ─────────────────────────────────────────────────────────

type AggRow = { label: string; sortKey: string; activeUsers: number; itemViews: number; sessions: number; orders: number; revenue: number };

function localISO(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getMondayISO(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + diff);
  return localISO(d);
}

function TimelineTable({ timeline }: { timeline: ReturnType<typeof buildTimeline> }) {
  const [tab, setTab] = useState<"daily" | "weekly" | "monthly">("daily");
  const sorted = [...timeline].sort((a, b) => a.isoDate.localeCompare(b.isoDate));

  function groupBy(keyFn: (iso: string) => string, labelFn: (iso: string, key: string) => string): AggRow[] {
    const map = new Map<string, AggRow>();
    for (const row of sorted) {
      const key = keyFn(row.isoDate);
      const ex = map.get(key) ?? { label: "", sortKey: key, activeUsers: 0, itemViews: 0, sessions: 0, orders: 0, revenue: 0 };
      ex.label = labelFn(row.isoDate, key);
      ex.activeUsers += row.activeUsers;
      ex.itemViews += row.itemViews;
      ex.sessions += row.sessions;
      ex.orders += row.orders;
      ex.revenue += row.revenue;
      map.set(key, ex);
    }
    return Array.from(map.values()).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }

  const rows: AggRow[] = (() => {
    if (tab === "daily") return sorted.map((r) => ({ label: r.isoDate, sortKey: r.isoDate, activeUsers: r.activeUsers, itemViews: r.itemViews, sessions: r.sessions, orders: r.orders, revenue: r.revenue }));
    if (tab === "weekly") return groupBy(getMondayISO, (_iso, key) => {
      const sun = new Date(key + "T00:00:00");
      sun.setDate(sun.getDate() + 6);
      return `${isoToLabel(key)}~${isoToLabel(localISO(sun))}`;
    });
    return groupBy((iso) => iso.slice(0, 7), (_iso, key) => `${key.slice(0, 4)}/${key.slice(5, 7)}`);
  })();

  const totals = rows.reduce(
    (acc, r) => ({ users: acc.users + r.activeUsers, sessions: acc.sessions + r.sessions, itemViews: acc.itemViews + r.itemViews, orders: acc.orders + r.orders, revenue: acc.revenue + r.revenue }),
    { users: 0, sessions: 0, itemViews: 0, orders: 0, revenue: 0 }
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">상세 데이터</CardTitle>
          <div className="flex rounded-md border overflow-hidden text-xs">
            {(["daily", "weekly", "monthly"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 transition-colors ${tab === t ? "bg-orange-500 text-white font-medium" : "text-muted-foreground hover:bg-muted"}`}
              >
                {t === "daily" ? "일간" : t === "weekly" ? "주간" : "월간"}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background border-b z-10">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">날짜</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">총 사용자</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">상품조회수</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">세션</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">주문 수</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">매출</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2 font-mono">{row.label}</td>
                  <td className="px-4 py-2 text-right">{row.activeUsers > 0 ? row.activeUsers.toLocaleString() : "—"}</td>
                  <td className="px-4 py-2 text-right">{row.itemViews > 0 ? row.itemViews.toLocaleString() : "—"}</td>
                  <td className="px-4 py-2 text-right">{row.sessions > 0 ? row.sessions.toLocaleString() : "—"}</td>
                  <td className="px-4 py-2 text-right">{row.orders > 0 ? `${row.orders}건` : "—"}</td>
                  <td className="px-4 py-2 text-right font-medium">{row.revenue > 0 ? formatRevenue(row.revenue) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 bg-background border-t">
              <tr>
                <td className="px-4 py-2 font-semibold text-xs">합계</td>
                <td className="px-4 py-2 text-right font-semibold">{totals.users.toLocaleString()}</td>
                <td className="px-4 py-2 text-right font-semibold">{totals.itemViews.toLocaleString()}</td>
                <td className="px-4 py-2 text-right font-semibold">{totals.sessions.toLocaleString()}</td>
                <td className="px-4 py-2 text-right font-semibold">{totals.orders}건</td>
                <td className="px-4 py-2 text-right font-semibold">{formatRevenue(totals.revenue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── EC 퍼널 ──────────────────────────────────────────────────────────────────

function FunnelSection({ data }: { data: AnalyticsData["funnel"] }) {
  const map = Object.fromEntries(data.map((d) => [d.eventName, d.eventCount]));
  const rows = FUNNEL_ORDER.map((key) => ({ key, count: map[key] ?? 0 }));
  const max = rows[0]?.count || 1;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">EC 퍼널</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row, i) => {
          const prev = i > 0 ? rows[i - 1].count : null;
          const rate = prev && prev > 0 ? ((row.count / prev) * 100).toFixed(1) : null;
          return (
            <div key={row.key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground font-mono">{row.key}</span>
                <div className="flex items-center gap-2">
                  {rate && <span className="text-xs text-muted-foreground">{rate}%</span>}
                  <span className="text-sm font-semibold">{row.count.toLocaleString()}</span>
                </div>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${max > 0 ? (row.count / max) * 100 : 0}%`, backgroundColor: PALETTE[i] }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── 상위 상품 ────────────────────────────────────────────────────────────────

function TopProductsTable({ data }: { data: ShopifyData["topProducts"] }) {
  const maxRev = data[0]?.revenue || 1;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">상위 판매 상품</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">상품명</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">수량</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">매출</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-14 shrink-0 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(row.revenue / maxRev) * 100}%`, backgroundColor: BRAND }} />
                    </div>
                    <span className="truncate max-w-[200px]">{translateTitle(row.title)}</span>
                  </div>
                </td>
                <td className="px-4 py-2 text-right">{row.quantity}개</td>
                <td className="px-4 py-2 text-right font-medium">{formatRevenue(row.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── 일자별 유입 소스 차트 ───────────────────────────────────────────────────────

const SOURCE_LABEL_MAP: Record<string, string> = {
  "google / organic": "Google 검색",
  "google / cpc": "Google 광고",
  "(direct) / (none)": "직접",
  "line / referral": "LINE",
  "instagram / referral": "Instagram",
  "yahoo / organic": "Yahoo 검색",
  "bing / organic": "Bing 검색",
};

function sourceLabel(source: string, medium: string) {
  return SOURCE_LABEL_MAP[`${source} / ${medium}`] ?? `${source} / ${medium}`;
}

function DailySourceChart({ data }: { data: AnalyticsData["trafficSourcesOverTime"] }) {
  const [selectedIso, setSelectedIso] = useState<string | null>(null);

  const top = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of data) {
      const k = `${row.sessionSource}|||${row.sessionMedium}`;
      totals.set(k, (totals.get(k) ?? 0) + Number(row.sessions));
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  }, [data]);

  // 날짜 → 원본 소스별 행 목록 (드릴다운용)
  const rawByIso = useMemo(() => {
    const map = new Map<string, { source: string; medium: string; sessions: number; activeUsers: number }[]>();
    for (const row of data) {
      const iso = ga4DateToISO(row.date);
      if (!map.has(iso)) map.set(iso, []);
      map.get(iso)!.push({
        source: row.sessionSource,
        medium: row.sessionMedium,
        sessions: Number(row.sessions),
        activeUsers: Number(row.activeUsers),
      });
    }
    for (const rows of map.values()) rows.sort((a, b) => b.sessions - a.sessions);
    return map;
  }, [data]);

  const chartData = useMemo(() => {
    const dateMap = new Map<string, Record<string, number | string>>();
    for (const row of data) {
      const iso = ga4DateToISO(row.date);
      if (!dateMap.has(iso)) dateMap.set(iso, { _date: isoToLabel(iso), _iso: iso });
      const entry = dateMap.get(iso)!;
      const k = `${row.sessionSource}|||${row.sessionMedium}`;
      const target = top.includes(k) ? k : "기타|||";
      entry[target] = ((entry[target] as number) ?? 0) + Number(row.sessions);
    }
    return [...dateMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  }, [data, top]);

  const keys = [...top, "기타|||"].filter(k => chartData.some(d => (d[k] as number) > 0));
  const interval = Math.max(0, Math.ceil(chartData.length / 10) - 1);

  const detailRows = selectedIso ? (rawByIso.get(selectedIso) ?? []) : [];
  const detailTotal = detailRows.reduce((s, r) => s + r.sessions, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">일자별 유입 소스</CardTitle>
        <p className="text-xs text-muted-foreground">
          날짜별 세션 수 — 상위 4개 소스/매체 + 기타
          {!selectedIso && <span className="ml-2 text-muted-foreground/60">막대 클릭 시 상세 내역</span>}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart
            data={chartData}
            margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
            onClick={(e) => {
              const iso = e?.activePayload?.[0]?.payload?._iso as string | undefined;
              if (iso) setSelectedIso(prev => prev === iso ? null : iso);
            }}
            style={{ cursor: "pointer" }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="_date" tick={{ fontSize: 10 }} interval={interval} />
            <YAxis tick={{ fontSize: 10 }} width={36} />
            <Tooltip
              formatter={(value: number, name: string) => {
                if (name === "기타|||") return [value.toLocaleString(), "기타"];
                const [src, med] = name.split("|||");
                return [value.toLocaleString(), sourceLabel(src, med)];
              }}
            />
            <Legend
              formatter={(v) => {
                if (v === "기타|||") return "기타";
                const [src, med] = v.split("|||");
                return sourceLabel(src, med);
              }}
              wrapperStyle={{ fontSize: 11 }}
            />
            {keys.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                stackId="src"
                fill={PALETTE[i % PALETTE.length]}
                radius={i === keys.length - 1 ? [2, 2, 0, 0] : undefined}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>

        {/* 드릴다운: 선택된 날짜의 전체 소스 내역 */}
        {selectedIso && (
          <div className="border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b">
              <span className="text-xs font-semibold">{selectedIso} 전체 유입 소스</span>
              <button
                onClick={() => setSelectedIso(null)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                닫기 ✕
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background border-b">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">소스 / 매체</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">세션</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">비율</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">사용자</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1 flex-1 max-w-[80px] bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${detailTotal > 0 ? (row.sessions / detailTotal) * 100 : 0}%`, backgroundColor: BRAND }}
                            />
                          </div>
                          <span>{sourceLabel(row.source, row.medium)}</span>
                          {sourceLabel(row.source, row.medium) !== `${row.source} / ${row.medium}` && (
                            <span className="text-muted-foreground/60">{row.source} / {row.medium}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-medium">{row.sessions.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {detailTotal > 0 ? ((row.sessions / detailTotal) * 100).toFixed(1) : 0}%
                      </td>
                      <td className="px-4 py-2 text-right">{row.activeUsers.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-background border-t">
                  <tr>
                    <td className="px-4 py-2 font-semibold">합계</td>
                    <td className="px-4 py-2 text-right font-semibold">{detailTotal.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">100%</td>
                    <td className="px-4 py-2 text-right font-semibold">
                      {detailRows.reduce((s, r) => s + r.activeUsers, 0).toLocaleString()}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 유입 경로 ────────────────────────────────────────────────────────────────

function TrafficSourcesTable({ data }: { data: AnalyticsData["trafficSources"] }) {
  const total = data.reduce((s, r) => s + (r.sessions as number), 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">유입 경로</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">소스 / 매체</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">세션</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground w-20">비율</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => {
              const sessions = row.sessions as number;
              const pct = total > 0 ? ((sessions / total) * 100).toFixed(1) : "0.0";
              return (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 max-w-[80px] rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: BRAND, opacity: 0.6 }} />
                      </div>
                      {row.sessionSource} / <span className="text-muted-foreground">{row.sessionMedium}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">{sessions.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{pct}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── 디바이스 ─────────────────────────────────────────────────────────────────

function DevicesChart({ data }: { data: AnalyticsData["devices"] }) {
  const LABELS: Record<string, string> = { mobile: "모바일", desktop: "데스크탑", tablet: "태블릿" };
  const formatted = data.map((d) => ({ name: LABELS[d.deviceCategory as string] ?? d.deviceCategory, value: d.sessions as number }));
  const total = formatted.reduce((s, r) => s + r.value, 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">디바이스</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <ResponsiveContainer width={100} height={100}>
          <PieChart>
            <Pie data={formatted} cx="50%" cy="50%" innerRadius={28} outerRadius={46} dataKey="value" paddingAngle={2}>
              {formatted.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-2 flex-1">
          {formatted.map((d, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                {d.name}
              </div>
              <span className="font-medium">{total > 0 ? ((d.value / total) * 100).toFixed(1) : 0}%</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── 상위 페이지 ──────────────────────────────────────────────────────────────

function TopPagesTable({ data }: { data: AnalyticsData["topPages"] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">상위 페이지</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">페이지</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">PV</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">유저</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">체류</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-2 font-mono truncate max-w-[220px]">{row.pagePath}</td>
                <td className="px-4 py-2 text-right">{(row.screenPageViews as number).toLocaleString()}</td>
                <td className="px-4 py-2 text-right">{(row.activeUsers as number).toLocaleString()}</td>
                <td className="px-4 py-2 text-right">{formatDuration(row.averageSessionDuration as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── 운영 현황 탭 (재고 부족 + 인기 아이템) ───────────────────────────────────

function OperationsPanel({
  lowStock, topProducts, itemViews,
}: {
  lowStock: ShopifyData["lowStock"];
  topProducts: ShopifyData["topProducts"];
  itemViews: AnalyticsData["itemViews"];
}) {
  // 상품명 정규화 (소문자 + 공백/특수문자 제거)
  const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_·・]/g, "");

  // GA4 itemName 기준 뷰 맵
  const viewMap = useMemo(() => {
    const m = new Map<string, { views: number; carts: number }>();
    for (const d of itemViews) {
      m.set(normalize(d.itemName as string), {
        views: d.itemsViewed as number,
        carts: d.itemsAddedToCart as number,
      });
    }
    return m;
  }, [itemViews]);

  // Shopify 상품명 정규화 후 GA4 뷰 매칭
  const merged = useMemo(() => topProducts.map((p) => {
    const key = normalize(p.title);
    // 정확 매칭 우선, 없으면 포함 관계 확인
    let match = viewMap.get(key);
    if (!match) {
      for (const [k, v] of viewMap) {
        if (key.includes(k) || k.includes(key)) { match = v; break; }
      }
    }
    return { ...p, views: match?.views ?? 0, carts: match?.carts ?? 0 };
  }), [topProducts, viewMap]);

  const maxRev = topProducts[0]?.revenue || 1;
  const maxViews = Math.max(...merged.map((r) => r.views), 1);
  return (
    <Card>
      <Tabs defaultValue="lowstock">
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">운영 현황</CardTitle>
            <TabsList className="h-7 text-xs">
              <TabsTrigger value="lowstock" className="h-6 text-xs px-3 flex items-center gap-1.5">
                재고 부족
                {lowStock.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 text-[10px] font-medium">
                    {lowStock.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="popular" className="h-6 text-xs px-3">인기 아이템</TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>

        {/* 재고 부족 탭 */}
        <TabsContent value="lowstock" className="mt-0">
          <CardContent className="p-0">
            {lowStock.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">재고 부족 상품 없음</p>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background border-b">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">상품</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">잔여 재고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowStock.map((row, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5">
                          {translateTitle(row.title)}
                          {row.variant && <span className="text-muted-foreground ml-1">({row.variant})</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={`font-semibold ${row.quantity === 0 ? "text-red-600" : "text-orange-500"}`}>
                            {row.quantity === 0 ? "품절" : `${row.quantity}개`}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </TabsContent>

        {/* 인기 아이템 탭 */}
        <TabsContent value="popular" className="mt-0">
          <CardContent className="p-0">
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background border-b">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">상품명</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">조회</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">판매</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">매출</th>
                  </tr>
                </thead>
                <tbody>
                  {merged.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-4 shrink-0 text-right">{i + 1}</span>
                          <div className="flex flex-col gap-0.5 w-12 shrink-0">
                            <div className="h-1 rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${(row.revenue / maxRev) * 100}%`, backgroundColor: BRAND }} />
                            </div>
                            <div className="h-1 rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full bg-blue-400" style={{ width: `${(row.views / maxViews) * 100}%` }} />
                            </div>
                          </div>
                          <span className="truncate max-w-[160px]">{translateTitle(row.title)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {row.views > 0 ? row.views.toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">{row.quantity.toLocaleString()}개</td>
                      <td className="px-4 py-2.5 text-right font-medium">{formatRevenue(row.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </TabsContent>
      </Tabs>
    </Card>
  );
}

// ─── 퍼널 분석 탭 ────────────────────────────────────────────────────────────

const FUNNEL_STEPS = [
  { key: "sessions",       label: "전체 세션",    color: "#f85a24" },
  { key: "view_item",      label: "상품 조회",    color: "#fb8c5a" },
  { key: "add_to_cart",    label: "장바구니 추가", color: "#f59e0b" },
  { key: "begin_checkout", label: "결제 시작",    color: "#10b981" },
  { key: "purchase",       label: "구매 완료",    color: "#3b82f6" },
];

function VisualFunnel({
  funnel, sessions,
}: {
  funnel: AnalyticsData["funnel"];
  sessions: number;
}) {
  const eventMap = Object.fromEntries(funnel.map((d) => [d.eventName, d.eventCount as number]));
  const steps = FUNNEL_STEPS.map((s) => ({
    ...s,
    count: s.key === "sessions" ? sessions : (eventMap[s.key] ?? 0),
  }));
  const maxCount = Math.max(...steps.map((s) => s.count), 1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">구매 전환 퍼널</CardTitle>
        <p className="text-xs text-muted-foreground">각 단계별 사용자 수 및 이탈률</p>
      </CardHeader>
      <CardContent className="space-y-1 pt-2">
        {steps.map((step, i) => {
          const prev = i > 0 ? steps[i - 1].count : null;
          const dropRate = prev && prev > 0
            ? (((prev - step.count) / prev) * 100).toFixed(1)
            : null;
          const convRate = prev && prev > 0
            ? ((step.count / prev) * 100).toFixed(1)
            : null;
          const widthPct = maxCount > 0 ? (step.count / maxCount) * 100 : 0;

          return (
            <div key={step.key}>
              {/* 이탈률 표시 */}
              {dropRate && (
                <div className="flex items-center gap-2 py-1 pl-4">
                  <div className="w-px h-4 bg-muted-foreground/30" />
                  <span className="text-[11px] text-muted-foreground">
                    ↓ {convRate}% 진입
                    <span className="ml-2 text-red-400">({dropRate}% 이탈)</span>
                  </span>
                </div>
              )}
              {/* 스텝 바 */}
              <div className="flex items-center gap-3">
                <div className="flex-1 relative">
                  <div
                    className="h-9 rounded-md flex items-center px-3 text-white text-xs font-medium transition-all duration-500"
                    style={{
                      width: `${Math.max(widthPct, 15)}%`,
                      backgroundColor: step.color,
                      minWidth: "80px",
                    }}
                  >
                    {step.label}
                  </div>
                </div>
                <div className="text-right w-28 shrink-0">
                  <span className="text-sm font-bold">{step.count.toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground ml-1">
                    ({maxCount > 0 ? ((step.count / maxCount) * 100).toFixed(1) : 0}%)
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// 페이지 유형 분류
function classifyPage(path: string): string {
  if (path === "/" || path === "") return "홈";
  if (path.startsWith("/product/")) return "상품 상세";
  if (path === "/checkout") return "결제";
  if (path === "/checkout-return") return "결제 완료";
  if (path === "/mypage") return "마이페이지";
  if (path === "/wishlist") return "위시리스트";
  if (path === "/contact") return "문의";
  return "기타";
}

// ─── 소스/매체별 전환율 ───────────────────────────────────────────────────────

function SourceConversionTable({ data }: { data: AnalyticsData["trafficSources"] }) {
  const rows = [...data]
    .map((r) => ({
      ...r,
      sessions: r.sessions as number,
      transactions: r.transactions as number,
      purchaseRevenue: r.purchaseRevenue as number,
      convRate: (r.sessions as number) > 0 ? ((r.transactions as number) / (r.sessions as number)) * 100 : 0,
    }))
    .filter((r) => r.sessions > 0)
    .sort((a, b) => b.convRate - a.convRate);

  const maxRev = Math.max(...rows.map((r) => r.purchaseRevenue), 1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">소스 / 매체별 전환율</CardTitle>
        <p className="text-xs text-muted-foreground">전환율 높은 순 — 전환율 = 구매 완료 / 세션</p>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">소스 / 매체</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">세션</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">구매</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">전환율</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">매출</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-16 shrink-0 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(row.purchaseRevenue / maxRev) * 100}%`, backgroundColor: BRAND, opacity: 0.7 }} />
                    </div>
                    <span>{row.sessionSource}</span>
                    <span className="text-muted-foreground">/ {row.sessionMedium}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">{row.sessions.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-right">{row.transactions > 0 ? row.transactions : "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  <span className={row.convRate >= 1 ? "text-green-600 font-semibold" : row.convRate > 0 ? "text-orange-500" : "text-muted-foreground"}>
                    {row.convRate > 0 ? `${row.convRate.toFixed(2)}%` : "—"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-medium">{row.purchaseRevenue > 0 ? formatRevenue(row.purchaseRevenue) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function ExitPagesTable({ data }: { data: AnalyticsData["exitPages"] }) {
  // 이탈 위험도 = sessions × bounceRate (높을수록 이탈 영향 큼)
  const withRisk = data.map((d) => ({
    ...d,
    sessions: d.sessions as number,
    bounceRate: d.bounceRate as number,
    risk: (d.sessions as number) * (d.bounceRate as number),
    type: classifyPage(d.pagePath as string),
  }));
  const maxRisk = Math.max(...withRisk.map((d) => d.risk), 1);

  const getRiskLabel = (risk: number, max: number) => {
    const pct = risk / max;
    if (pct > 0.6) return { label: "높음", cls: "text-red-600 bg-red-50" };
    if (pct > 0.3) return { label: "중간", cls: "text-orange-500 bg-orange-50" };
    return { label: "낮음", cls: "text-green-600 bg-green-50" };
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">페이지별 이탈 포인트</CardTitle>
        <p className="text-xs text-muted-foreground">이탈 위험도 = 트래픽 × 이탈률 (높은 순)</p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">페이지</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">유형</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">세션</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">이탈률</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">체류</th>
                <th className="px-4 py-2 font-medium text-muted-foreground text-center">위험도</th>
              </tr>
            </thead>
            <tbody>
              {withRisk
                .sort((a, b) => b.risk - a.risk)
                .map((row, i) => {
                  const { label, cls } = getRiskLabel(row.risk, maxRisk);
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5 font-mono truncate max-w-[180px]">{row.pagePath}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{row.type}</td>
                      <td className="px-4 py-2.5 text-right">{row.sessions.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className={row.bounceRate > 0.5 ? "text-red-500 font-medium" : ""}>
                          {(row.bounceRate * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">{formatDuration(row.averageSessionDuration as number)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${cls}`}>
                          {label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function PageTypeSummary({ data }: { data: AnalyticsData["exitPages"] }) {
  const grouped = new Map<string, { sessions: number; bounceTotal: number; count: number }>();
  for (const d of data) {
    const type = classifyPage(d.pagePath as string);
    const ex = grouped.get(type) ?? { sessions: 0, bounceTotal: 0, count: 0 };
    ex.sessions += d.sessions as number;
    ex.bounceTotal += (d.bounceRate as number) * (d.sessions as number);
    ex.count += 1;
    grouped.set(type, ex);
  }
  const rows = Array.from(grouped.entries())
    .map(([type, v]) => ({ type, sessions: v.sessions, avgBounce: v.sessions > 0 ? v.bounceTotal / v.sessions : 0 }))
    .sort((a, b) => b.sessions - a.sessions);
  const maxSessions = rows[0]?.sessions || 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">페이지 유형별 요약</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row, i) => (
          <div key={i}>
            <div className="flex items-center justify-between mb-1 text-xs">
              <span className="font-medium">{row.type}</span>
              <div className="flex items-center gap-3 text-muted-foreground">
                <span>{row.sessions.toLocaleString()} 세션</span>
                <span className={row.avgBounce > 0.5 ? "text-red-500 font-medium" : ""}>
                  이탈률 {(row.avgBounce * 100).toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${(row.sessions / maxSessions) * 100}%`, backgroundColor: BRAND, opacity: 0.7 }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ─── 비밀번호 게이트 ───────────────────────────────────────────────────────────

function PasswordGate({ onAuth }: { onAuth: (s: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm px-6">
        <div className="mb-8 text-center">
          <div className="text-2xl font-bold" style={{ color: BRAND }}>BITEME</div>
          <p className="text-sm text-muted-foreground mt-1">Admin Dashboard</p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (!value.trim()) { setError(true); return; } onAuth(value.trim()); }} className="space-y-4">
          <div>
            <input
              type="password"
              placeholder="관리자 시크릿 키"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(false); }}
              className={`w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 transition-all ${error ? "border-red-400 focus:ring-red-200" : "border-input focus:ring-ring/30"}`}
              autoFocus
            />
            {error && <p className="text-xs text-red-500 mt-1">키를 입력해주세요</p>}
          </div>
          <button type="submit" className="w-full py-2 rounded-lg text-sm font-medium text-white hover:opacity-90 transition-opacity" style={{ backgroundColor: BRAND }}>
            로그인
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── 메인 대시보드 ────────────────────────────────────────────────────────────

const RANGE_LABELS: Record<Range, string> = { today: "오늘", "7d": "7일", "28d": "28일", "90d": "90일", custom: "기간 지정" };

// 인증된 상태의 대시보드 (secret이 항상 존재하는 상태에서만 렌더됨)
function DashboardView({ secret, onLogout }: { secret: string; onLogout: () => void }) {
  const [range, setRange] = useState<Range>("7d");
  const [customDates, setCustomDates] = useState<DateRange | undefined>();
  const [calOpen, setCalOpen] = useState(false);

  const customFrom = customDates?.from ? format(customDates.from, "yyyy-MM-dd") : undefined;
  const customTo = customDates?.to ? format(customDates.to, "yyyy-MM-dd") : undefined;
  const canQuery = range !== "custom" || (!!customFrom && !!customTo);

  const retry = (count: number, err: unknown) => {
    if (err instanceof Error && err.message === "UNAUTHORIZED") return false;
    return count < 2;
  };

  const { data, isLoading: ga4Loading, isError, error, refetch } = useQuery({
    queryKey: ["analytics", range, secret, customFrom, customTo],
    queryFn: () => fetchAnalytics(range, secret, customFrom, customTo),
    staleTime: 5 * 60 * 1000,
    enabled: canQuery,
    retry,
  });

  const { data: shopify, isLoading: shopifyLoading, isError: shopifyIsError, error: shopifyErr } = useQuery({
    queryKey: ["shopify-analytics", range, secret, customFrom, customTo],
    queryFn: () => fetchShopify(range, secret, customFrom, customTo),
    staleTime: 5 * 60 * 1000,
    enabled: canQuery,
    retry,
  });

  const isUnauthorized = isError && error instanceof Error && error.message === "UNAUTHORIZED";

  // 인증 실패 시 로그아웃 처리 (side-effect이므로 useEffect 사용)
  useEffect(() => {
    if (isUnauthorized) onLogout();
  }, [isUnauthorized, onLogout]);

  // 상품명 번역 — 번역된 버전을 별도 state로 관리해야 리렌더가 올바르게 동작함
  const [translatedShopify, setTranslatedShopify] = useState<ShopifyData | null>(null);
  useEffect(() => {
    if (!shopify) { setTranslatedShopify(null); return; }
    const titles = [
      ...shopify.topProducts.map((p) => p.title),
      ...shopify.lowStock.map((p) => p.title),
    ];
    translateBatch(titles).then((cache) => {
      setTranslatedShopify({
        ...shopify,
        topProducts: shopify.topProducts.map((p) => ({ ...p, title: cache.get(p.title) ?? p.title })),
        lowStock: shopify.lowStock.map((p) => ({ ...p, title: cache.get(p.title) ?? p.title })),
      });
    });
  }, [shopify]);

  const ov = data?.overview ?? {};
  const sessions = (ov.sessions as number) ?? 0;
  const totalOrders = shopify?.summary.totalOrders ?? 0;
  const totalRevenue = shopify?.summary.totalRevenue ?? 0;
  const aov = shopify?.summary.averageOrderValue ?? 0;
  const convRate = sessions > 0 ? ((totalOrders / sessions) * 100).toFixed(2) : "—";
  const isLoading = ga4Loading || shopifyLoading || (!data && !shopify && !isError && !shopifyIsError);

  const timeline = useMemo(() => {
    if (!data || !shopify) return [];
    return buildTimeline(data.revenueOverTime, shopify.dailyOrders);
  }, [data, shopify]);

  return (
    <div className="min-h-screen bg-muted/30">
      {/* 헤더 */}
      <div className="bg-background border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm" style={{ color: BRAND }}>BITEME</span>
            <span className="text-xs text-muted-foreground">Analytics</span>
          </div>
          <div className="flex items-center gap-2">
            {/* 프리셋 범위 버튼 */}
            <div className="flex rounded-lg border bg-background overflow-hidden text-xs">
              {(["today", "7d", "28d", "90d"] as Range[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-3 py-1.5 transition-colors ${range === r ? "text-white font-medium" : "text-muted-foreground hover:text-foreground"}`}
                  style={range === r ? { backgroundColor: BRAND } : {}}
                >
                  {RANGE_LABELS[r]}
                </button>
              ))}
            </div>

            {/* 커스텀 날짜 캘린더 피커 */}
            <Popover open={calOpen} onOpenChange={setCalOpen}>
              <PopoverTrigger asChild>
                <button
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors ${range === "custom" ? "text-white font-medium" : "text-muted-foreground hover:text-foreground"}`}
                  style={range === "custom" ? { backgroundColor: BRAND } : {}}
                >
                  <CalendarIcon className="h-3 w-3" />
                  {range === "custom" && customFrom
                    ? customTo
                      ? `${customFrom} ~ ${customTo}`
                      : customFrom
                    : "날짜 지정"}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="range"
                  selected={customDates}
                  onSelect={(val) => {
                    setCustomDates(val);
                    setRange("custom");
                    if (val?.from && val?.to) setCalOpen(false);
                  }}
                  numberOfMonths={2}
                  disabled={{ after: new Date() }}
                  defaultMonth={customDates?.from ?? new Date()}
                />
              </PopoverContent>
            </Popover>

            <button onClick={() => refetch()} className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted transition-colors">새로고침</button>
            <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground transition-colors">로그아웃</button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {isLoading && (
          <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">데이터를 불러오는 중...</div>
        )}

        {/* 에러 */}
        {isError && !isUnauthorized && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            GA4 오류: {error instanceof Error ? error.message : "알 수 없는 오류"}
          </div>
        )}
        {shopifyIsError && !(shopifyErr instanceof Error && shopifyErr.message === "UNAUTHORIZED") && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            Shopify 오류: {shopifyErr instanceof Error ? shopifyErr.message : "알 수 없는 오류"}
          </div>
        )}

        {(data || shopify) && (
          <Tabs defaultValue="dashboard" className="space-y-5">
            <TabsList className="h-9">
              <TabsTrigger value="dashboard" className="text-xs px-4">대시보드</TabsTrigger>
              <TabsTrigger value="funnel" className="text-xs px-4">퍼널 분석</TabsTrigger>
            </TabsList>

            {/* ══ 대시보드 탭 ══ */}
            <TabsContent value="dashboard" className="space-y-5 mt-0">
              {/* ── 핵심 비즈니스 지표 ── */}
              <SectionLabel>핵심 지표</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiCard label="총 매출" value={formatRevenue(totalRevenue)} accent />
                <KpiCard label="주문 수" value={`${totalOrders.toLocaleString()}건`} accent />
                <KpiCard label="평균 주문금액" value={formatRevenue(aov)} accent />
                <KpiCard
                  label="구매 전환율"
                  value={convRate === "—" ? "—" : `${convRate}%`}
                  sub={`세션 ${sessions.toLocaleString()} → 주문 ${totalOrders}`}
                  accent
                />
              </div>

              {/* ── 트래픽 지표 ── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiCard label="세션" value={sessions.toLocaleString()} />
                <KpiCard label="유저" value={((ov.activeUsers as number) ?? 0).toLocaleString()} />
                <KpiCard label="이탈률" value={`${(((ov.bounceRate as number) ?? 0) * 100).toFixed(1)}%`} />
                <KpiCard label="평균 체류 시간" value={formatDuration((ov.averageSessionDuration as number) ?? 0)} />
              </div>

              {/* ── 통합 추이 차트 + 일자별 표 ── */}
              {timeline.length > 0 && (
                <>
                  <CombinedChart timeline={timeline} />
                  <TimelineTable timeline={timeline} />
                </>
              )}

              {/* ── EC 퍼널 + 상위 상품 ── */}
              <SectionLabel>전환 · 상품</SectionLabel>
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                {data && <div className="lg:col-span-2"><FunnelSection data={data.funnel} /></div>}
                {shopify && <div className="lg:col-span-3"><TopProductsTable data={(translatedShopify ?? shopify).topProducts} /></div>}
              </div>

              {/* ── 트래픽 분석 ── */}
              {data && (
                <>
                  <SectionLabel>트래픽 분석</SectionLabel>
                  <DailySourceChart data={data.trafficSourcesOverTime} />
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="lg:col-span-2"><TrafficSourcesTable data={data.trafficSources} /></div>
                    <DevicesChart data={data.devices} />
                  </div>
                  <TopPagesTable data={data.topPages} />
                </>
              )}

              {/* ── 운영 현황 ── */}
              {shopify && (
                <>
                  <SectionLabel>운영 현황</SectionLabel>
                  <OperationsPanel lowStock={(translatedShopify ?? shopify).lowStock} topProducts={(translatedShopify ?? shopify).topProducts} itemViews={data?.itemViews ?? []} />
                </>
              )}

              <p className="text-center text-xs text-muted-foreground pb-4">
                GA4: G-WLTZH90W2L · Shopify: biteme-jp.myshopify.com · {RANGE_LABELS[range]} 데이터
              </p>
            </TabsContent>

            {/* ══ 퍼널 분석 탭 ══ */}
            <TabsContent value="funnel" className="space-y-5 mt-0">
              {data ? (
                <>
                  <SectionLabel>구매 전환 퍼널</SectionLabel>
                  <VisualFunnel funnel={data.funnel} sessions={sessions} />

                  <SectionLabel>소스 / 매체별 전환</SectionLabel>
                  <SourceConversionTable data={data.trafficSources} />

                  <SectionLabel>이탈 포인트 분석</SectionLabel>
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="lg:col-span-2">
                      <ExitPagesTable data={data.exitPages} />
                    </div>
                    <PageTypeSummary data={data.exitPages} />
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
                  GA4 데이터를 불러오는 중...
                </div>
              )}

              <p className="text-center text-xs text-muted-foreground pb-4">
                GA4: G-WLTZH90W2L · {RANGE_LABELS[range]} 데이터
              </p>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}

// ─── 진입점: 인증 게이트만 담당 ──────────────────────────────────────────────

export default function AdminDashboard() {
  const [secret, setSecret] = useState(() => sessionStorage.getItem("adminSecret") || "");

  if (!secret) {
    return (
      <PasswordGate
        onAuth={(s) => {
          sessionStorage.setItem("adminSecret", s);
          setSecret(s);
        }}
      />
    );
  }

  return (
    <DashboardView
      secret={secret}
      onLogout={() => {
        sessionStorage.removeItem("adminSecret");
        setSecret("");
      }}
    />
  );
}
