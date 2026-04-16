import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ─── Types ────────────────────────────────────────────────────────────────────

type Range = "today" | "7d" | "28d" | "90d";

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
  revenueOverTime: { date: string; purchaseRevenue: number; transactions: number; sessions: number }[];
  topPages: { pagePath: string; screenPageViews: number; activeUsers: number; averageSessionDuration: number }[];
  trafficSources: { sessionSource: string; sessionMedium: string; sessions: number; activeUsers: number }[];
  devices: { deviceCategory: string; sessions: number }[];
  itemViews: { itemId: string; itemViews: number; addToCarts: number }[];
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

// GA4 sessions + Shopify orders/revenue를 날짜 기준으로 합침
function buildTimeline(
  ga4: AnalyticsData["revenueOverTime"],
  shopify: ShopifyData["dailyOrders"]
) {
  const map = new Map<string, { date: string; sessions: number; orders: number; revenue: number }>();
  for (const d of shopify) {
    map.set(d.date, { date: isoToLabel(d.date), sessions: 0, orders: d.orders, revenue: d.revenue });
  }
  for (const d of ga4) {
    const key = ga4DateToISO(d.date);
    const ex = map.get(key) ?? { date: isoToLabel(key), sessions: 0, orders: 0, revenue: 0 };
    ex.sessions = d.sessions;
    map.set(key, ex);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

const FUNNEL_ORDER = ["view_item", "add_to_cart", "begin_checkout", "purchase"] as const;

// ─── API ──────────────────────────────────────────────────────────────────────

async function fetchAnalytics(range: Range, secret: string): Promise<AnalyticsData> {
  const res = await fetch(`/api/analytics?range=${range}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "GA4 오류"); }
  return res.json();
}

async function fetchShopify(range: Range, secret: string): Promise<ShopifyData> {
  const res = await fetch(`/api/shopify-analytics?range=${range}`, { headers: { Authorization: `Bearer ${secret}` } });
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
        <p className="text-xs text-muted-foreground">세션(막대) / 매출(주황선) / 주문수(회색선)</p>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={timeline} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={interval} />
            <YAxis yAxisId="sess" tick={{ fontSize: 10 }} width={36} />
            <YAxis yAxisId="rev" orientation="right" tick={{ fontSize: 10 }} tickFormatter={(v) => `¥${(v / 1000).toFixed(0)}k`} width={48} />
            <Tooltip
              formatter={(value: number, name: string) => {
                if (name === "revenue") return [formatRevenue(value), "매출"];
                if (name === "sessions") return [value.toLocaleString(), "세션"];
                return [value, "주문 수"];
              }}
            />
            <Legend
              formatter={(v) => v === "revenue" ? "매출" : v === "sessions" ? "세션" : "주문 수"}
              wrapperStyle={{ fontSize: 11 }}
            />
            <Bar yAxisId="sess" dataKey="sessions" fill={BRAND} opacity={0.25} radius={[2, 2, 0, 0]} />
            <Line yAxisId="rev" type="monotone" dataKey="revenue" stroke={BRAND} strokeWidth={2.5} dot={false} />
            <Line yAxisId="sess" type="monotone" dataKey="orders" stroke="#94a3b8" strokeWidth={1.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
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
                    <span className="truncate max-w-[200px]">{row.title}</span>
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
  // GA4 itemViews를 Shopify product GID 기준으로 매핑
  const viewMap = useMemo(() => {
    const m = new Map<string, { views: number; carts: number }>();
    for (const d of itemViews) {
      // GA4 itemId = "gid://shopify/Product/1234567890" 형태
      m.set(d.itemId as string, {
        views: d.itemViews as number,
        carts: d.addToCarts as number,
      });
    }
    return m;
  }, [itemViews]);

  // Shopify productId(GID)로 GA4 조회수 정확 매칭
  const merged = useMemo(() => topProducts.map((p) => {
    const match = viewMap.get(p.productId);
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
                          {row.title}
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
                          <span className="truncate max-w-[160px]">{row.title}</span>
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

const RANGE_LABELS: Record<Range, string> = { today: "오늘", "7d": "7일", "28d": "28일", "90d": "90일" };

export default function AdminDashboard() {
  const [secret, setSecret] = useState(() => sessionStorage.getItem("adminSecret") || "");
  const [range, setRange] = useState<Range>("7d");

  const handleAuth = useCallback((s: string) => { sessionStorage.setItem("adminSecret", s); setSecret(s); }, []);

  const retry = (count: number, err: unknown) => {
    if (err instanceof Error && err.message === "UNAUTHORIZED") return false;
    return count < 2;
  };

  const { data, isLoading: ga4Loading, isError, error, refetch } = useQuery({
    queryKey: ["analytics", range, secret],
    queryFn: () => fetchAnalytics(range, secret),
    enabled: !!secret,
    staleTime: 5 * 60 * 1000,
    retry,
  });

  const { data: shopify, isLoading: shopifyLoading, isError: shopifyIsError, error: shopifyErr } = useQuery({
    queryKey: ["shopify-analytics", range, secret],
    queryFn: () => fetchShopify(range, secret),
    enabled: !!secret,
    staleTime: 5 * 60 * 1000,
    retry,
  });

  const isUnauthorized = isError && error instanceof Error && error.message === "UNAUTHORIZED";
  if (!secret || isUnauthorized) {
    if (isUnauthorized) sessionStorage.removeItem("adminSecret");
    return <PasswordGate onAuth={handleAuth} />;
  }

  const ov = data?.overview ?? {};
  const sessions = (ov.sessions as number) ?? 0;
  const totalOrders = shopify?.summary.totalOrders ?? 0;
  const totalRevenue = shopify?.summary.totalRevenue ?? 0;
  const aov = shopify?.summary.averageOrderValue ?? 0;
  const convRate = sessions > 0 ? ((totalOrders / sessions) * 100).toFixed(2) : "—";
  const isLoading = ga4Loading || shopifyLoading;

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
            <button onClick={() => refetch()} className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted transition-colors">새로고침</button>
            <button onClick={() => { sessionStorage.removeItem("adminSecret"); setSecret(""); }} className="text-xs text-muted-foreground hover:text-foreground transition-colors">로그아웃</button>
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
          <>
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

            {/* ── 통합 추이 차트 ── */}
            {timeline.length > 0 && <CombinedChart timeline={timeline} />}

            {/* ── EC 퍼널 + 상위 상품 ── */}
            {(data || shopify) && (
              <>
                <SectionLabel>전환 · 상품</SectionLabel>
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                  {data && <div className="lg:col-span-2"><FunnelSection data={data.funnel} /></div>}
                  {shopify && <div className="lg:col-span-3"><TopProductsTable data={shopify.topProducts} /></div>}
                </div>
              </>
            )}

            {/* ── 트래픽 분석 ── */}
            {data && (
              <>
                <SectionLabel>트래픽 분석</SectionLabel>
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
                <OperationsPanel lowStock={shopify.lowStock} topProducts={shopify.topProducts} itemViews={data?.itemViews ?? []} />
              </>
            )}

            <p className="text-center text-xs text-muted-foreground pb-4">
              GA4: G-WLTZH90W2L · Shopify: biteme-jp.myshopify.com · {RANGE_LABELS[range]} 데이터
            </p>
          </>
        )}
      </div>
    </div>
  );
}
