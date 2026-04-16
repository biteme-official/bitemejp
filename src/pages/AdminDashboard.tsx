import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ─── Types ────────────────────────────────────────────────────────────────────

type Range = "today" | "7d" | "28d" | "90d";

interface AnalyticsData {
  overview: {
    sessions?: number;
    activeUsers?: number;
    newUsers?: number;
    bounceRate?: number;
    averageSessionDuration?: number;
    purchaseRevenue?: number;
    transactions?: number;
  };
  funnel: { eventName: string; eventCount: number }[];
  revenueOverTime: { date: string; purchaseRevenue: number; transactions: number; sessions: number }[];
  topPages: { pagePath: string; screenPageViews: number; activeUsers: number; averageSessionDuration: number }[];
  trafficSources: { sessionSource: string; sessionMedium: string; sessions: number; activeUsers: number }[];
  devices: { deviceCategory: string; sessions: number }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BRAND = "#f85a24";
const PALETTE = ["#f85a24", "#fb8c5a", "#fdb997", "#fdd8c5", "#ffe9e0"];

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatRevenue(value: number): string {
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

function formatDate(raw: string): string {
  // "20241201" → "12/01"
  if (raw.length === 8) return `${raw.slice(4, 6)}/${raw.slice(6, 8)}`;
  return raw;
}

const FUNNEL_ORDER = ["view_item", "add_to_cart", "begin_checkout", "purchase"] as const;
const FUNNEL_LABELS: Record<string, string> = {
  view_item: "商品閲覧",
  add_to_cart: "カート追加",
  begin_checkout: "決済開始",
  purchase: "購入完了",
};

// ─── API fetch ────────────────────────────────────────────────────────────────

async function fetchAnalytics(range: Range, secret: string): Promise<AnalyticsData> {
  const res = await fetch(`/api/analytics?range=${range}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "Failed to fetch analytics");
  }
  return res.json();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        <p className="text-2xl font-bold tracking-tight">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function FunnelSection({ data }: { data: AnalyticsData["funnel"] }) {
  const map = Object.fromEntries(data.map((d) => [d.eventName, d.eventCount]));
  const rows = FUNNEL_ORDER.map((key) => ({ key, label: FUNNEL_LABELS[key], count: map[key] ?? 0 }));
  const max = rows[0]?.count || 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">ECファネル</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row, i) => {
          const prev = i > 0 ? rows[i - 1].count : null;
          const rate = prev && prev > 0 ? ((row.count / prev) * 100).toFixed(1) : null;
          return (
            <div key={row.key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground">{row.label}</span>
                <div className="flex items-center gap-2">
                  {rate && (
                    <span className="text-xs text-muted-foreground">↑ {rate}%</span>
                  )}
                  <span className="text-sm font-medium">{row.count.toLocaleString()}</span>
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

function RevenueChart({ data, range }: { data: AnalyticsData["revenueOverTime"]; range: Range }) {
  const formatted = data.map((d) => ({
    ...d,
    date: formatDate(d.date as string),
  }));
  const showEveryNth = range === "90d" ? 7 : 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">売上推移</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={formatted} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              interval={showEveryNth - 1}
            />
            <YAxis
              yAxisId="rev"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => `¥${(v / 1000).toFixed(0)}k`}
              width={48}
            />
            <YAxis yAxisId="txn" orientation="right" tick={{ fontSize: 10 }} width={24} />
            <Tooltip
              formatter={(value: number, name: string) =>
                name === "purchaseRevenue" ? [formatRevenue(value), "売上"] : [value, "件数"]
              }
            />
            <Line yAxisId="rev" type="monotone" dataKey="purchaseRevenue" stroke={BRAND} strokeWidth={2} dot={false} name="purchaseRevenue" />
            <Line yAxisId="txn" type="monotone" dataKey="transactions" stroke="#94a3b8" strokeWidth={1.5} dot={false} name="transactions" />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function SessionsChart({ data }: { data: AnalyticsData["revenueOverTime"] }) {
  const formatted = data.map((d) => ({ date: formatDate(d.date as string), sessions: d.sessions }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">セッション推移</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={formatted} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={Math.ceil(formatted.length / 10) - 1} />
            <YAxis tick={{ fontSize: 10 }} width={36} />
            <Tooltip formatter={(v: number) => [v.toLocaleString(), "セッション"]} />
            <Bar dataKey="sessions" fill={BRAND} opacity={0.8} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function TopPagesTable({ data }: { data: AnalyticsData["topPages"] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">上位ページ</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">ページ</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">PV</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">ユーザー</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">滞在時間</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2 font-mono max-w-[200px] truncate">{row.pagePath}</td>
                  <td className="px-4 py-2 text-right">{(row.screenPageViews as number).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{(row.activeUsers as number).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{formatDuration(row.averageSessionDuration as number)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function TrafficSourcesTable({ data }: { data: AnalyticsData["trafficSources"] }) {
  const total = data.reduce((s, r) => s + (r.sessions as number), 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">流入元</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">ソース / メディア</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">セッション</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">割合</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => {
                const sessions = row.sessions as number;
                const pct = total > 0 ? ((sessions / total) * 100).toFixed(1) : "0.0";
                return (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2">
                      {row.sessionSource} / <span className="text-muted-foreground">{row.sessionMedium}</span>
                    </td>
                    <td className="px-4 py-2 text-right">{sessions.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">{pct}%</td>
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

function DevicesChart({ data }: { data: AnalyticsData["devices"] }) {
  const DEVICE_LABELS: Record<string, string> = {
    mobile: "モバイル",
    desktop: "デスクトップ",
    tablet: "タブレット",
  };
  const formatted = data.map((d) => ({
    name: DEVICE_LABELS[d.deviceCategory as string] ?? d.deviceCategory,
    value: d.sessions as number,
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">デバイス</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <ResponsiveContainer width={120} height={120}>
          <PieChart>
            <Pie data={formatted} cx="50%" cy="50%" innerRadius={32} outerRadius={52} dataKey="value" paddingAngle={2}>
              {formatted.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-2 flex-1">
          {formatted.map((d, i) => {
            const total = formatted.reduce((s, r) => s + r.value, 0);
            const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : "0.0";
            return (
              <div key={i} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                  {d.name}
                </div>
                <span className="font-medium">{pct}%</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Password Gate ────────────────────────────────────────────────────────────

function PasswordGate({ onAuth }: { onAuth: (secret: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) { setError(true); return; }
    setError(false);
    onAuth(value.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm px-6">
        <div className="mb-8 text-center">
          <div className="text-2xl font-bold" style={{ color: BRAND }}>BITEME</div>
          <p className="text-sm text-muted-foreground mt-1">Admin Dashboard</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              placeholder="管理者シークレットキー"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(false); }}
              className={`w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 transition-all ${
                error ? "border-red-400 focus:ring-red-200" : "border-input focus:ring-ring/30"
              }`}
              autoFocus
            />
            {error && <p className="text-xs text-red-500 mt-1">キーを入力してください</p>}
          </div>
          <button
            type="submit"
            className="w-full py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 active:opacity-80"
            style={{ backgroundColor: BRAND }}
          >
            ログイン
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

const RANGE_LABELS: Record<Range, string> = {
  today: "今日",
  "7d": "7日間",
  "28d": "28日間",
  "90d": "90日間",
};

export default function AdminDashboard() {
  const [secret, setSecret] = useState<string>(() => sessionStorage.getItem("adminSecret") || "");
  const [range, setRange] = useState<Range>("7d");

  const handleAuth = useCallback((s: string) => {
    sessionStorage.setItem("adminSecret", s);
    setSecret(s);
  }, []);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["analytics", range, secret],
    queryFn: () => fetchAnalytics(range, secret),
    enabled: !!secret,
    staleTime: 5 * 60 * 1000,
    retry: (count, err) => {
      if (err instanceof Error && err.message === "UNAUTHORIZED") return false;
      return count < 2;
    },
  });

  const isUnauthorized = isError && error instanceof Error && error.message === "UNAUTHORIZED";

  if (!secret || isUnauthorized) {
    if (isUnauthorized) sessionStorage.removeItem("adminSecret");
    return (
      <PasswordGate
        onAuth={handleAuth}
      />
    );
  }

  const ov = data?.overview ?? {};
  const convRate = ov.sessions && (ov.sessions as number) > 0
    ? (((ov.transactions as number ?? 0) / (ov.sessions as number)) * 100).toFixed(2)
    : "—";

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <div className="bg-background border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-bold text-sm" style={{ color: BRAND }}>BITEME</span>
            <span className="text-sm font-medium text-muted-foreground">Analytics</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Range tabs */}
            <div className="flex rounded-lg border bg-background overflow-hidden text-xs">
              {(["today", "7d", "28d", "90d"] as Range[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-3 py-1.5 transition-colors ${
                    range === r
                      ? "text-white font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  style={range === r ? { backgroundColor: BRAND } : {}}
                >
                  {RANGE_LABELS[r]}
                </button>
              ))}
            </div>
            <button
              onClick={() => refetch()}
              className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted transition-colors"
            >
              更新
            </button>
            <button
              onClick={() => {
                sessionStorage.removeItem("adminSecret");
                setSecret("");
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ログアウト
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {isLoading && (
          <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
            データを読み込み中...
          </div>
        )}

        {isError && !isUnauthorized && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error instanceof Error ? error.message : "エラーが発生しました"}
          </div>
        )}

        {data && (
          <>
            {/* KPI Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <KpiCard label="セッション" value={(ov.sessions as number ?? 0).toLocaleString()} />
              <KpiCard label="ユーザー" value={(ov.activeUsers as number ?? 0).toLocaleString()} />
              <KpiCard label="新規ユーザー" value={(ov.newUsers as number ?? 0).toLocaleString()} />
              <KpiCard
                label="直帰率"
                value={`${(((ov.bounceRate as number ?? 0)) * 100).toFixed(1)}%`}
              />
              <KpiCard
                label="平均滞在時間"
                value={formatDuration(ov.averageSessionDuration as number ?? 0)}
              />
              <KpiCard
                label="購入転換率"
                value={convRate === "—" ? "—" : `${convRate}%`}
                sub={`${(ov.transactions as number ?? 0)}件 / ${formatRevenue(ov.purchaseRevenue as number ?? 0)}`}
              />
            </div>

            {/* Funnel + Revenue */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <FunnelSection data={data.funnel} />
              <div className="lg:col-span-2 space-y-4">
                <RevenueChart data={data.revenueOverTime} range={range} />
              </div>
            </div>

            {/* Sessions chart */}
            <SessionsChart data={data.revenueOverTime} />

            {/* Pages + Sources + Devices */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2">
                <TopPagesTable data={data.topPages} />
              </div>
              <DevicesChart data={data.devices} />
            </div>

            <TrafficSourcesTable data={data.trafficSources} />

            <p className="text-center text-xs text-muted-foreground pb-4">
              GA4 Property: G-WLTZH90W2L &nbsp;·&nbsp; {RANGE_LABELS[range]}のデータ
            </p>
          </>
        )}
      </div>
    </div>
  );
}
