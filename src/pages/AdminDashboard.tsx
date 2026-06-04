import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from "recharts";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, ClipboardCopy, Check } from "lucide-react";
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
  notSetLandingPages: { date: string; landingPage: string; sessions: number; activeUsers: number }[];
  devices: { deviceCategory: string; sessions: number }[];
  itemViews: { itemName: string; itemsViewed: number; itemsAddedToCart: number }[];
  exitPages: { pagePath: string; sessions: number; bounceRate: number; screenPageViews: number; averageSessionDuration: number }[];
  newVsReturning: { newVsReturning: string; activeUsers: number; sessions: number }[];
}

interface InstagramDay {
  date: string;
  followerDelta: number | null;
  cumulativeFollowers: number | null;
  postsPublished: number;
  postReach: number;
  postEngagement: number;
}

interface InstagramData {
  daily: InstagramDay[];
  currentFollowers: number;
  configured: boolean;
}

interface CustomerData {
  totalCustomers: number;
  newCustomersCount: number;
  repeatCustomers: number;
  repeatRate: number;
  segments: { noOrders: number; oneOrder: number; twoThreeOrders: number; fourPlusOrders: number };
  avgNewLTV: number;
  dailyNewCustomers: { date: string; count: number }[];
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
function getWeekLabel(mondayISO: string): string {
  const sunday = new Date(mondayISO + "T00:00:00");
  sunday.setDate(sunday.getDate() + 6);
  const month = sunday.getMonth() + 1;
  const monthStart = new Date(sunday.getFullYear(), sunday.getMonth(), 1);
  const monthStartDow = (monthStart.getDay() + 6) % 7;
  const weekNum = Math.ceil((sunday.getDate() + monthStartDow) / 7);
  return `${month}월 ${weekNum}주차`;
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

interface BehaviorData {
  funnel: { step: string; label: string; count: number }[];
  bannerRanking: { label: string; count: number }[];
  categoryRanking: { label: string; count: number }[];
  productRanking: { label: string; count: number }[];
}

async function fetchBehavior(range: Range, secret: string): Promise<BehaviorData> {
  const params = new URLSearchParams({ range });
  const res = await fetch(`/api/behavior-analytics?${params}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "행동 데이터 오류"); }
  return res.json();
}

async function fetchInstagram(range: Range, secret: string, customFrom?: string, customTo?: string): Promise<InstagramData> {
  const params = new URLSearchParams({ range });
  if (range === "custom" && customFrom && customTo) { params.set("from", customFrom); params.set("to", customTo); }
  const res = await fetch(`/api/instagram-analytics?${params}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "Instagram 오류"); }
  return res.json();
}

async function postFollowerData(rows: { date: string; followers_count: number }[], secret: string): Promise<void> {
  const res = await fetch("/api/instagram-follower-input", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "저장 실패"); }
}

async function fetchCustomers(range: Range, secret: string, customFrom?: string, customTo?: string): Promise<CustomerData> {
  const params = new URLSearchParams({ range });
  if (range === "custom" && customFrom && customTo) { params.set("from", customFrom); params.set("to", customTo); }
  const res = await fetch(`/api/customer-analytics?${params}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "회원 데이터 오류"); }
  return res.json();
}

// ─── 공통 컴포넌트 ─────────────────────────────────────────────────────────────

function CopyButton({ getData }: { getData: () => string }) {
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    await navigator.clipboard.writeText(getData());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handle}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border hover:bg-muted"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <ClipboardCopy className="h-3 w-3" />}
      {copied ? "복사됨" : "복사"}
    </button>
  );
}

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
          <div className="flex items-center gap-2">
          <CopyButton getData={() => {
            const header = "날짜\t총 사용자\t상품조회수\t세션\t주문 수\t매출(¥)";
            const lines = rows.map(r =>
              `${r.label}\t${r.activeUsers}\t${r.itemViews}\t${r.sessions}\t${r.orders}\t${r.revenue}`
            );
            return [header, ...lines].join("\n");
          }} />
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
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">상위 판매 상품</CardTitle>
          <CopyButton getData={() => {
            const header = "상품명\t수량\t매출(¥)";
            const lines = data.map(r => `${translateTitle(r.title)}\t${r.quantity}\t${r.revenue}`);
            return [header, ...lines].join("\n");
          }} />
        </div>
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

function DailySourceChart({ data, notSetLandingPages }: {
  data: AnalyticsData["trafficSourcesOverTime"];
  notSetLandingPages: AnalyticsData["notSetLandingPages"];
}) {
  const [selectedIso, setSelectedIso] = useState<string | null>(null);
  const [showLanding, setShowLanding] = useState(false);

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

  // 날짜 → (not set) 세션의 랜딩 페이지 목록
  const landingByIso = useMemo(() => {
    const map = new Map<string, { landingPage: string; sessions: number; activeUsers: number }[]>();
    for (const row of notSetLandingPages) {
      const iso = ga4DateToISO(row.date);
      if (!map.has(iso)) map.set(iso, []);
      map.get(iso)!.push({
        landingPage: row.landingPage as string,
        sessions: Number(row.sessions),
        activeUsers: Number(row.activeUsers),
      });
    }
    for (const rows of map.values()) rows.sort((a, b) => b.sessions - a.sessions);
    return map;
  }, [notSetLandingPages]);

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
  const landingRows = selectedIso ? (landingByIso.get(selectedIso) ?? []) : [];
  const landingTotal = landingRows.reduce((s, r) => s + r.sessions, 0);
  const hasNotSet = detailRows.some(r => r.source === "(not set)");

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
                onClick={() => { setSelectedIso(null); setShowLanding(false); }}
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
                  {detailRows.map((row, i) => {
                    const isNotSet = row.source === "(not set)";
                    return (
                      <tr
                        key={i}
                        className={`border-b last:border-0 transition-colors ${isNotSet && landingRows.length > 0 ? "cursor-pointer hover:bg-amber-50" : "hover:bg-muted/30"}`}
                        onClick={isNotSet && landingRows.length > 0 ? () => setShowLanding(p => !p) : undefined}
                      >
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
                            {isNotSet && landingRows.length > 0 && (
                              <span className="ml-auto text-[10px] text-amber-600 font-medium">
                                랜딩 페이지 {showLanding ? "▲" : "▼"}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-medium">{row.sessions.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">
                          {detailTotal > 0 ? ((row.sessions / detailTotal) * 100).toFixed(1) : 0}%
                        </td>
                        <td className="px-4 py-2 text-right">{row.activeUsers.toLocaleString()}</td>
                      </tr>
                    );
                  })}
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

            {/* (not set) 랜딩 페이지 드릴다운 */}
            {hasNotSet && showLanding && landingRows.length > 0 && (
              <div className="border-t">
                <div className="px-4 py-2 bg-amber-50 border-b">
                  <span className="text-xs font-semibold text-amber-700">(not set) 세션 — 랜딩 페이지 분포</span>
                  <p className="text-[10px] text-amber-600 mt-0.5">소스는 특정 불가, 어느 페이지로 처음 진입했는지로 유추 가능</p>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-background border-b">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">랜딩 페이지</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">세션</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">비율</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">사용자</th>
                      </tr>
                    </thead>
                    <tbody>
                      {landingRows.map((row, i) => (
                        <tr key={i} className="border-b last:border-0 hover:bg-amber-50/50 transition-colors">
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-1 flex-1 max-w-[80px] bg-muted rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-amber-400"
                                  style={{ width: `${landingTotal > 0 ? (row.sessions / landingTotal) * 100 : 0}%` }}
                                />
                              </div>
                              <span className="font-mono truncate max-w-[260px]" title={row.landingPage}>{row.landingPage}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right font-medium">{row.sessions.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground">
                            {landingTotal > 0 ? ((row.sessions / landingTotal) * 100).toFixed(1) : 0}%
                          </td>
                          <td className="px-4 py-2 text-right">{row.activeUsers.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
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
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">유입 경로</CardTitle>
          <CopyButton getData={() => {
            const header = "소스/매체\t세션\t비율";
            const lines = data.map(r => {
              const sessions = r.sessions as number;
              const pct = total > 0 ? ((sessions / total) * 100).toFixed(1) : "0.0";
              return `${r.sessionSource} / ${r.sessionMedium}\t${sessions}\t${pct}%`;
            });
            return [header, ...lines].join("\n");
          }} />
        </div>
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
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">상위 페이지</CardTitle>
          <CopyButton getData={() => {
            const header = "페이지\tPV\t유저\t체류";
            const lines = data.map(r =>
              `${r.pagePath}\t${r.screenPageViews}\t${r.activeUsers}\t${formatDuration(r.averageSessionDuration as number)}`
            );
            return [header, ...lines].join("\n");
          }} />
        </div>
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
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold">소스 / 매체별 전환율</CardTitle>
            <p className="text-xs text-muted-foreground">전환율 높은 순 — 전환율 = 구매 완료 / 세션</p>
          </div>
          <CopyButton getData={() => {
            const header = "소스/매체\t세션\t구매\t전환율\t매출(¥)";
            const lines = rows.map(r =>
              `${r.sessionSource} / ${r.sessionMedium}\t${r.sessions}\t${r.transactions || 0}\t${r.convRate > 0 ? r.convRate.toFixed(2) + "%" : "0%"}\t${r.purchaseRevenue}`
            );
            return [header, ...lines].join("\n");
          }} />
        </div>
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
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold">페이지별 이탈 포인트</CardTitle>
            <p className="text-xs text-muted-foreground">이탈 위험도 = 트래픽 × 이탈률 (높은 순)</p>
          </div>
          <CopyButton getData={() => {
            const header = "페이지\t유형\t세션\t이탈률\t체류\t위험도";
            const sorted = withRisk.slice().sort((a, b) => b.risk - a.risk);
            const lines = sorted.map(r => {
              const { label } = getRiskLabel(r.risk, maxRisk);
              return `${r.pagePath}\t${r.type}\t${r.sessions}\t${(r.bounceRate * 100).toFixed(1)}%\t${formatDuration(r.averageSessionDuration as number)}\t${label}`;
            });
            return [header, ...lines].join("\n");
          }} />
        </div>
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

// ─── 회원 분석 컴포넌트 ────────────────────────────────────────────────────────

function NewCustomerTrendChart({ data }: { data: CustomerData["dailyNewCustomers"] }) {
  const interval = Math.max(0, Math.ceil(data.length / 10) - 1);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">신규 회원 가입 추이</CardTitle>
        <p className="text-xs text-muted-foreground">기간 내 일별 신규 가입 수</p>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={data.map(d => ({ ...d, label: isoToLabel(d.date) }))} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={interval} />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={36} />
            <Tooltip formatter={(v: number) => [v.toLocaleString() + "명", "신규 가입"]} />
            <Bar dataKey="count" fill={BRAND} opacity={0.8} radius={[3, 3, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function CustomerSegmentChart({ segments }: { segments: CustomerData["segments"] }) {
  const items = [
    { name: "미구매", value: segments.noOrders, color: "#e2e8f0" },
    { name: "1회 구매", value: segments.oneOrder, color: "#fdb997" },
    { name: "2~3회", value: segments.twoThreeOrders, color: "#fb8c5a" },
    { name: "4회 이상", value: segments.fourPlusOrders, color: BRAND },
  ].filter(d => d.value > 0);
  const total = items.reduce((s, d) => s + d.value, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">고객 구매 횟수 분포</CardTitle>
        <p className="text-xs text-muted-foreground">전체 회원 세그먼트</p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <PieChart width={140} height={140}>
            <Pie data={items} dataKey="value" cx={65} cy={65} innerRadius={38} outerRadius={60} paddingAngle={2}>
              {items.map((entry, i) => <Cell key={i} fill={entry.color} />)}
            </Pie>
          </PieChart>
          <div className="flex-1 space-y-2">
            {items.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  <span>{item.name}</span>
                </div>
                <div className="text-right">
                  <span className="font-medium">{item.value.toLocaleString()}명</span>
                  <span className="text-muted-foreground ml-1.5">
                    {total > 0 ? ((item.value / total) * 100).toFixed(1) : 0}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function NewVsReturningChart({ data }: { data: AnalyticsData["newVsReturning"] }) {
  const labeled = data.map(d => ({
    name: d.newVsReturning === "new" ? "신규 유저" : "재방문 유저",
    activeUsers: d.activeUsers,
    sessions: d.sessions,
    color: d.newVsReturning === "new" ? BRAND : "#94a3b8",
  }));
  const total = labeled.reduce((s, d) => s + d.activeUsers, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">신규 vs 재방문 유저</CardTitle>
        <p className="text-xs text-muted-foreground">GA4 기준 활성 사용자</p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 mt-1">
          {labeled.map((d, i) => (
            <div key={i}>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium">{d.name}</span>
                <span className="text-muted-foreground">
                  {d.activeUsers.toLocaleString()}명 ({total > 0 ? ((d.activeUsers / total) * 100).toFixed(1) : 0}%)
                </span>
              </div>
              <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${total > 0 ? (d.activeUsers / total) * 100 : 0}%`, backgroundColor: d.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── 행동 분석 컴포넌트 ────────────────────────────────────────────────────────

const BEHAVIOR_FUNNEL_COLORS = ["#f85a24", "#fb8c5a", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"];

function BehaviorFunnel({ funnel }: { funnel: BehaviorData["funnel"] }) {
  const maxCount = Math.max(...funnel.map((s) => s.count), 1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">구매 전환 퍼널</CardTitle>
        <p className="text-xs text-muted-foreground">각 단계에 도달한 고유 세션 수 (Supabase 이벤트 기반)</p>
      </CardHeader>
      <CardContent className="space-y-1 pt-2">
        {funnel.map((step, i) => {
          const prev = i > 0 ? funnel[i - 1].count : null;
          const dropRate = prev && prev > 0 ? (((prev - step.count) / prev) * 100).toFixed(1) : null;
          const convRate = prev && prev > 0 ? ((step.count / prev) * 100).toFixed(1) : null;
          const widthPct = maxCount > 0 ? (step.count / maxCount) * 100 : 0;
          return (
            <div key={step.step}>
              {dropRate && (
                <div className="flex items-center gap-2 py-1 pl-4">
                  <div className="w-px h-4 bg-muted-foreground/30" />
                  <span className="text-[11px] text-muted-foreground">
                    ↓ {convRate}% 진입
                    <span className="ml-2 text-red-400">({dropRate}% 이탈)</span>
                  </span>
                </div>
              )}
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div
                    className="h-9 rounded-md flex items-center px-3 text-white text-xs font-medium transition-all duration-500"
                    style={{ width: `${Math.max(widthPct, 15)}%`, backgroundColor: BEHAVIOR_FUNNEL_COLORS[i % BEHAVIOR_FUNNEL_COLORS.length], minWidth: "80px" }}
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

function RankingTable({ title, data }: { title: string; data: { label: string; count: number }[] }) {
  const max = data[0]?.count || 1;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          {data.length > 0 && (
            <CopyButton getData={() => {
              const header = "순위\t항목\t클릭 수";
              const lines = data.map((r, i) => `${i + 1}\t${r.label}\t${r.count}`);
              return [header, ...lines].join("\n");
            }} />
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {data.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">데이터 없음</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">항목</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">클릭 수</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-4 shrink-0 text-right">{i + 1}</span>
                      <div className="h-1.5 w-14 shrink-0 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(row.count / max) * 100}%`, backgroundColor: BRAND }} />
                      </div>
                      <span className="truncate max-w-[160px]">{row.label}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right font-medium">{row.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 주간회고 탭 ──────────────────────────────────────────────────────────────

function pctChange(curr: number, prev: number | undefined): number | null {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function PctBadge({ v }: { v: number | null | undefined }) {
  if (v == null) return null;
  const pos = v >= 0;
  return <span className={`text-[10px] ${pos ? "text-green-600" : "text-red-500"}`}>{pos ? "▲" : "▼"}{Math.abs(v).toFixed(1)}%</span>;
}

function FollowerInputModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (rows: { date: string; followers_count: number }[]) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ date: string; followers_count: number }[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function parseText() {
    const rows = text.trim().split("\n").map((line) => {
      const [d, c] = line.trim().split(/[\t,]/);
      const count = parseInt((c ?? "").replace(/[^0-9]/g, ""), 10);
      return { date: (d ?? "").trim(), followers_count: count };
    }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.followers_count > 0);
    setPreview(rows);
  }

  async function save() {
    setSaving(true); setErr(null);
    try { await onSave(preview); }
    catch (e) { setErr(e instanceof Error ? e.message : "오류 발생"); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-background rounded-xl border shadow-xl w-full max-w-lg space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">팔로워 수 수기 입력</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <p className="text-xs text-muted-foreground">날짜(YYYY-MM-DD)와 팔로워 수를 탭 또는 쉼표로 구분해서 붙여넣으세요. 스프레드시트에서 복사해서 붙여넣기 가능합니다.</p>
        <div className="bg-muted rounded p-2 text-[11px] font-mono text-muted-foreground leading-5">
          2025-12-01&nbsp;&nbsp;&nbsp;24000<br />
          2025-12-08&nbsp;&nbsp;&nbsp;24150<br />
          2025-12-15&nbsp;&nbsp;&nbsp;24320
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview([]); }}
          className="w-full h-36 border rounded-lg px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring/30"
          placeholder={"2025-12-01\t24000\n2025-12-08\t24150"}
        />
        <div className="flex items-center gap-2">
          <button onClick={parseText} className="px-3 py-1.5 text-xs rounded border hover:bg-muted transition-colors">파싱 미리보기</button>
          {preview.length > 0 && <span className="text-xs text-muted-foreground">{preview.length}개 행 인식됨</span>}
        </div>
        {preview.length > 0 && (
          <div className="max-h-32 overflow-y-auto border rounded text-xs">
            <table className="w-full">
              <thead className="sticky top-0 bg-muted">
                <tr><th className="text-left px-2 py-1 font-medium">날짜</th><th className="text-right px-2 py-1 font-medium">팔로워</th></tr>
              </thead>
              <tbody>
                {preview.slice(0, 10).map((r, i) => (
                  <tr key={i} className="border-t"><td className="px-2 py-1 font-mono">{r.date}</td><td className="px-2 py-1 text-right">{r.followers_count.toLocaleString()}</td></tr>
                ))}
                {preview.length > 10 && <tr><td colSpan={2} className="px-2 py-1 text-center text-muted-foreground">외 {preview.length - 10}개</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {err && <p className="text-xs text-red-500">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border hover:bg-muted transition-colors">취소</button>
          <button onClick={save} disabled={preview.length === 0 || saving}
            className="px-3 py-1.5 text-xs rounded font-medium text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
            style={{ backgroundColor: BRAND }}>
            {saving ? "저장 중..." : `${preview.length}개 저장`}
          </button>
        </div>
      </div>
    </div>
  );
}

function WeeklyReviewTab({
  timeline,
  instagram,
  secret,
}: {
  timeline: ReturnType<typeof buildTimeline>;
  instagram: InstagramData | null | undefined;
  secret: string;
}) {
  const [viewTab, setViewTab] = useState<"daily" | "weekly" | "monthly">("daily");
  const [showInput, setShowInput] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const igByDate = useMemo(() => new Map((instagram?.daily ?? []).map((d) => [d.date, d])), [instagram]);
  const sorted = useMemo(() => [...timeline].sort((a, b) => a.isoDate.localeCompare(b.isoDate)), [timeline]);

  function buildAgg(days: typeof sorted) {
    const igDays = days.map((d) => igByDate.get(d.isoDate)).filter((x): x is InstagramDay => !!x);
    return {
      dau: days.reduce((s, d) => s + d.activeUsers, 0),
      revenue: days.reduce((s, d) => s + d.revenue, 0),
      orders: days.reduce((s, d) => s + d.orders, 0),
      itemViews: days.reduce((s, d) => s + d.itemViews, 0),
      sessions: days.reduce((s, d) => s + d.sessions, 0),
      followerDelta: igDays.some((d) => d.followerDelta !== null)
        ? igDays.reduce((s, d) => s + (d.followerDelta ?? 0), 0)
        : null,
      cumulativeFollowers: igDays[igDays.length - 1]?.cumulativeFollowers ?? null,
      postsPublished: igDays.reduce((s, d) => s + d.postsPublished, 0),
      postReach: igDays.reduce((s, d) => s + d.postReach, 0),
      postEngagement: igDays.reduce((s, d) => s + d.postEngagement, 0),
    };
  }

  const dailyRows = useMemo(() => sorted.map((day) => {
    const ig = igByDate.get(day.isoDate);
    return {
      label: day.isoDate,
      dau: day.activeUsers, revenue: day.revenue, orders: day.orders,
      itemViews: day.itemViews, sessions: day.sessions,
      followerDelta: ig?.followerDelta ?? null,
      cumulativeFollowers: ig?.cumulativeFollowers ?? null,
      postsPublished: ig?.postsPublished ?? 0,
      postReach: ig?.postReach ?? 0,
      postEngagement: ig?.postEngagement ?? 0,
    };
  }), [sorted, igByDate]);

  const weeklyRows = useMemo(() => {
    const groups = new Map<string, typeof sorted>();
    for (const row of sorted) {
      const key = getMondayISO(row.isoDate);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    const raw = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([mondayISO, days]) => ({ label: getWeekLabel(mondayISO), ...buildAgg(days) }));
    return raw.map((row, i) => ({
      ...row,
      dauPct: pctChange(row.dau, raw[i - 1]?.dau),
      revenuePct: pctChange(row.revenue, raw[i - 1]?.revenue),
      ordersPct: pctChange(row.orders, raw[i - 1]?.orders),
      postReachPct: pctChange(row.postReach, raw[i - 1]?.postReach),
    }));
  }, [sorted, igByDate]);

  const monthlyRows = useMemo(() => {
    const groups = new Map<string, typeof sorted>();
    for (const row of sorted) {
      const key = row.isoDate.slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    const raw = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, days]) => ({
        label: `${parseInt(key.slice(5, 7))}월`,
        ...buildAgg(days),
      }));
    return raw.map((row, i) => ({
      ...row,
      dauPct: pctChange(row.dau, raw[i - 1]?.dau),
      revenuePct: pctChange(row.revenue, raw[i - 1]?.revenue),
      ordersPct: pctChange(row.orders, raw[i - 1]?.orders),
      postReachPct: pctChange(row.postReach, raw[i - 1]?.postReach),
    }));
  }, [sorted, igByDate]);

  // TSV helpers
  const COL_HEADERS = ["기간", "DAU", "매출(¥)", "주문수", "상품조회", "객단가(¥)", "CVR", "팔로우 증감", "누적 팔로워", "게시글 수", "게시글 도달", "게시글당 도달", "게시글 인게이지", "인게이지율"];
  function rowToTsv(r: { label: string; dau: number; revenue: number; orders: number; itemViews: number; sessions: number; followerDelta: number | null; cumulativeFollowers: number | null; postsPublished: number; postReach: number; postEngagement: number }) {
    const aov = r.orders > 0 ? Math.round(r.revenue / r.orders) : 0;
    const cvr = r.sessions > 0 ? (r.orders / r.sessions) * 100 : 0;
    const rpp = r.postsPublished > 0 ? Math.round(r.postReach / r.postsPublished) : 0;
    const er = r.postReach > 0 ? (r.postEngagement / r.postReach) * 100 : 0;
    return [r.label, r.dau || "", r.revenue || "", r.orders || "", r.itemViews || "", aov || "",
      cvr > 0 ? cvr.toFixed(2) + "%" : "", r.followerDelta ?? "", r.cumulativeFollowers ?? "",
      r.postsPublished || "", r.postReach || "", rpp || "", r.postEngagement || "", er > 0 ? er.toFixed(2) + "%" : ""].join("\t");
  }
  function tsvData() {
    const rows = viewTab === "daily" ? dailyRows : viewTab === "weekly" ? weeklyRows : monthlyRows;
    return [COL_HEADERS.join("\t"), ...rows.map(rowToTsv)].join("\n");
  }

  // Shared table header
  const changeLabel = viewTab === "weekly" ? "WoW" : "MoM";
  const THead = ({ showChange }: { showChange: boolean }) => (
    <thead className="sticky top-0 z-20 bg-background border-b">
      <tr>
        <th className="sticky left-0 z-30 bg-background text-left px-3 py-2 font-medium text-muted-foreground min-w-[100px]">기간</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">DAU{showChange && <span className="block text-[9px] text-muted-foreground/60">{changeLabel}</span>}</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">매출{showChange && <span className="block text-[9px] text-muted-foreground/60">{changeLabel}</span>}</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">주문수{showChange && <span className="block text-[9px] text-muted-foreground/60">{changeLabel}</span>}</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">상품조회</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">객단가</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">CVR</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground border-l border-muted">팔로우 증감</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">누적 팔로워</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground border-l border-muted">게시글 수</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">게시글 도달{showChange && <span className="block text-[9px] text-muted-foreground/60">{changeLabel}</span>}</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">게시글당 도달</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">인게이지</th>
        <th className="text-right px-3 py-2 font-medium text-muted-foreground">인게이지율</th>
      </tr>
    </thead>
  );

  function TRow({ r, highlight }: { r: typeof dailyRows[0] & { dauPct?: number | null; revenuePct?: number | null; ordersPct?: number | null; postReachPct?: number | null }; highlight?: boolean }) {
    const aov = r.orders > 0 ? Math.round(r.revenue / r.orders) : 0;
    const cvr = r.sessions > 0 ? (r.orders / r.sessions) * 100 : 0;
    const rpp = r.postsPublished > 0 ? Math.round(r.postReach / r.postsPublished) : 0;
    const er = r.postReach > 0 ? (r.postEngagement / r.postReach) * 100 : 0;
    const cls = highlight ? "bg-orange-50 font-semibold border-t-2 border-orange-200" : "border-b hover:bg-muted/30 transition-colors";
    const stickyBg = highlight ? "bg-orange-50" : "bg-background";
    return (
      <tr className={cls}>
        <td className={`sticky left-0 z-10 px-3 py-2 font-mono ${stickyBg} ${highlight ? "text-orange-700" : ""}`}>{r.label}</td>
        <td className="px-3 py-2 text-right">{r.dau > 0 ? r.dau.toLocaleString() : "—"}<PctBadge v={r.dauPct} /></td>
        <td className="px-3 py-2 text-right">{r.revenue > 0 ? formatRevenue(r.revenue) : "—"}<PctBadge v={r.revenuePct} /></td>
        <td className="px-3 py-2 text-right">{r.orders > 0 ? r.orders.toLocaleString() : "—"}<PctBadge v={r.ordersPct} /></td>
        <td className="px-3 py-2 text-right">{r.itemViews > 0 ? r.itemViews.toLocaleString() : "—"}</td>
        <td className="px-3 py-2 text-right">{aov > 0 ? formatRevenue(aov) : "—"}</td>
        <td className="px-3 py-2 text-right">{cvr > 0 ? `${cvr.toFixed(2)}%` : "—"}</td>
        <td className="px-3 py-2 text-right border-l border-muted">
          {r.followerDelta !== null
            ? <span className={r.followerDelta >= 0 ? "text-green-600" : "text-red-500"}>{r.followerDelta >= 0 ? "+" : ""}{r.followerDelta.toLocaleString()}</span>
            : "—"}
        </td>
        <td className="px-3 py-2 text-right">{r.cumulativeFollowers !== null ? r.cumulativeFollowers.toLocaleString() : "—"}</td>
        <td className="px-3 py-2 text-right border-l border-muted">{r.postsPublished > 0 ? r.postsPublished : "—"}</td>
        <td className="px-3 py-2 text-right">{r.postReach > 0 ? r.postReach.toLocaleString() : "—"}<PctBadge v={r.postReachPct} /></td>
        <td className="px-3 py-2 text-right">{rpp > 0 ? rpp.toLocaleString() : "—"}</td>
        <td className="px-3 py-2 text-right">{r.postEngagement > 0 ? r.postEngagement.toLocaleString() : "—"}</td>
        <td className="px-3 py-2 text-right">{er > 0 ? `${er.toFixed(2)}%` : "—"}</td>
      </tr>
    );
  }

  return (
    <div className="space-y-3">
      {showInput && (
        <FollowerInputModal
          onClose={() => setShowInput(false)}
          onSave={async (rows) => {
            await postFollowerData(rows, secret);
            setSaveMsg(`${rows.length}개 저장 완료`);
            setShowInput(false);
            setTimeout(() => setSaveMsg(null), 3000);
          }}
        />
      )}
      {instagram && !instagram.configured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
          Instagram 미연동 — <code className="font-mono bg-amber-100 px-1 rounded">INSTAGRAM_ACCESS_TOKEN</code> / <code className="font-mono bg-amber-100 px-1 rounded">INSTAGRAM_ACCOUNT_ID</code> 환경 변수가 필요합니다.
        </div>
      )}
      {saveMsg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-xs text-green-700">{saveMsg}</div>
      )}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-semibold">주간회고 데이터</CardTitle>
              <div className="flex rounded-md border overflow-hidden text-xs">
                {(["daily", "weekly", "monthly"] as const).map((t) => (
                  <button key={t} onClick={() => setViewTab(t)}
                    className={`px-3 py-1 transition-colors ${viewTab === t ? "text-white font-medium" : "text-muted-foreground hover:bg-muted"}`}
                    style={viewTab === t ? { backgroundColor: BRAND } : {}}>
                    {t === "daily" ? "일간" : t === "weekly" ? "주간" : "월간"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowInput(true)}
                className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                팔로워 수기 입력
              </button>
              <CopyButton getData={tsvData} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
            <table className="text-xs whitespace-nowrap border-collapse w-full">
              {viewTab === "daily" && (
                <>
                  <THead showChange={false} />
                  <tbody>{dailyRows.map((r, i) => <TRow key={i} r={r} />)}</tbody>
                </>
              )}
              {viewTab === "weekly" && (
                <>
                  <THead showChange={true} />
                  <tbody>{weeklyRows.map((r, i) => <TRow key={i} r={r} highlight />)}</tbody>
                </>
              )}
              {viewTab === "monthly" && (
                <>
                  <THead showChange={true} />
                  <tbody>{monthlyRows.map((r, i) => <TRow key={i} r={r} highlight />)}</tbody>
                </>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
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
  const [activeTab, setActiveTab] = useState("dashboard");

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

  const { data: customers, isLoading: customersLoading } = useQuery({
    queryKey: ["customer-analytics", range, secret, customFrom, customTo],
    queryFn: () => fetchCustomers(range, secret, customFrom, customTo),
    staleTime: 5 * 60 * 1000,
    enabled: canQuery,
    retry,
  });

  const { data: behavior } = useQuery({
    queryKey: ["behavior-analytics", range, secret],
    queryFn: () => fetchBehavior(range, secret),
    staleTime: 3 * 60 * 1000,
    enabled: canQuery,
    retry,
  });

  const { data: instagram } = useQuery({
    queryKey: ["instagram-analytics", range, secret, customFrom, customTo],
    queryFn: () => fetchInstagram(range, secret, customFrom, customTo),
    staleTime: 10 * 60 * 1000,
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
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
            <TabsList className="h-9">
              <TabsTrigger value="dashboard" className="text-xs px-4">대시보드</TabsTrigger>
              <TabsTrigger value="funnel" className="text-xs px-4">퍼널 분석</TabsTrigger>
              <TabsTrigger value="behavior" className="text-xs px-4">행동 분석</TabsTrigger>
              <TabsTrigger value="members" className="text-xs px-4">회원 분석</TabsTrigger>
              <TabsTrigger value="weekly" className="text-xs px-4">주간회고</TabsTrigger>
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
                  <DailySourceChart data={data.trafficSourcesOverTime} notSetLandingPages={data.notSetLandingPages} />
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

            {/* ══ 회원 분석 탭 ══ */}
            <TabsContent value="members" className="space-y-5 mt-0">
              {customersLoading ? (
                <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
                  회원 데이터를 불러오는 중...
                </div>
              ) : customers ? (
                <>
                  <SectionLabel>회원 핵심 지표</SectionLabel>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <KpiCard label="총 회원 수" value={`${customers.totalCustomers.toLocaleString()}명`} accent />
                    <KpiCard
                      label="신규 가입"
                      value={`${customers.newCustomersCount.toLocaleString()}명`}
                      sub={`${RANGE_LABELS[range]} 신규 등록`}
                      accent
                    />
                    <KpiCard
                      label="재구매율"
                      value={`${(customers.repeatRate * 100).toFixed(1)}%`}
                      sub={`${customers.repeatCustomers.toLocaleString()}명 (2회 이상 구매)`}
                    />
                    <KpiCard
                      label="신규 고객 평균 LTV"
                      value={customers.avgNewLTV > 0 ? formatRevenue(customers.avgNewLTV) : "—"}
                      sub="신규 가입 구매 고객 기준"
                    />
                  </div>

                  <SectionLabel>가입 · 세그먼트</SectionLabel>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <NewCustomerTrendChart data={customers.dailyNewCustomers} />
                    <CustomerSegmentChart segments={customers.segments} />
                  </div>

                  {data?.newVsReturning && data.newVsReturning.length > 0 && (
                    <>
                      <SectionLabel>유저 재방문</SectionLabel>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <NewVsReturningChart data={data.newVsReturning} />
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-semibold">세그먼트 상세</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b">
                                  <th className="text-left py-2 font-medium text-muted-foreground">구분</th>
                                  <th className="text-right py-2 font-medium text-muted-foreground">활성 유저</th>
                                  <th className="text-right py-2 font-medium text-muted-foreground">세션</th>
                                </tr>
                              </thead>
                              <tbody>
                                {data.newVsReturning.map((row, i) => (
                                  <tr key={i} className="border-b last:border-0">
                                    <td className="py-2.5 font-medium">
                                      {row.newVsReturning === "new" ? "신규 유저" : "재방문 유저"}
                                    </td>
                                    <td className="py-2.5 text-right">{(row.activeUsers as number).toLocaleString()}</td>
                                    <td className="py-2.5 text-right">{(row.sessions as number).toLocaleString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </CardContent>
                        </Card>
                      </div>
                    </>
                  )}

                  <p className="text-center text-xs text-muted-foreground pb-4">
                    Shopify: biteme-jp.myshopify.com · GA4: G-WLTZH90W2L · {RANGE_LABELS[range]} 데이터
                  </p>
                </>
              ) : (
                <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
                  회원 데이터를 불러올 수 없습니다.
                </div>
              )}
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

            {/* ══ 행동 분석 탭 ══ */}
            <TabsContent value="behavior" className="space-y-5 mt-0">
              {!behavior ? (
                <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
                  행동 데이터를 불러오는 중...
                </div>
              ) : (
                <>
                  <SectionLabel>클릭 전환 퍼널</SectionLabel>
                  <BehaviorFunnel funnel={behavior.funnel} />

                  <SectionLabel>클릭 랭킹</SectionLabel>
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <RankingTable title="배너 클릭" data={behavior.bannerRanking} />
                    <RankingTable title="카테고리 클릭" data={behavior.categoryRanking} />
                    <RankingTable title="상품 클릭" data={behavior.productRanking} />
                  </div>

                  <p className="text-center text-xs text-muted-foreground pb-4">
                    Supabase click_events · {RANGE_LABELS[range]} 데이터
                  </p>
                </>
              )}
            </TabsContent>
            {/* ══ 주간회고 탭 ══ */}
            <TabsContent value="weekly" className="space-y-5 mt-0">
              {timeline.length > 0 ? (
                <WeeklyReviewTab timeline={timeline} instagram={instagram} secret={secret} />
              ) : (
                <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
                  데이터를 불러오는 중...
                </div>
              )}
              <p className="text-center text-xs text-muted-foreground pb-4">
                GA4 + Shopify + Instagram · {RANGE_LABELS[range]} 데이터
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
