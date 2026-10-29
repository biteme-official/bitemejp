import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 어드민 「사이트 성과」 탭 (#264) — biteme-promotion 「플랫폼 성과」(/admin/platform-stats) 틀을 일본몰에 맞춤.
 *
 * 탭 셋: 유입 경로(GA4) · 구매 퍼널(GA4 + 자체 이벤트) · 메인 화면 구좌(자체 이벤트 events 표).
 * 기간은 7·30·90일, 늘 어제까지(JST). 데이터는 /api/site-report 한 번 — 서버가 30분 캐시.
 *
 * 그림 규칙은 원본을 따른다: 차트 라이브러리 없이 div 막대. 경로(채널)는 고정 색, 비율·수는 회색 막대.
 * 단위가 다른 값은 한 축에 안 올리고 같은 행 순서의 두 그림으로 나눈다.
 */
const ADMIN_API_BASE = (import.meta.env.VITE_ADMIN_API_BASE_URL as string) ?? "";

type Days = 7 | 30 | 90;

interface Traffic { sessions: number; users: number; newUsers: number; addToCarts: number; transactions: number; revenue: number }
interface SlotStat { clicks: number; sessions: number; checkoutSessions: number; orderSessions: number; orderValue: number }
interface SiteReport {
  days: number;
  from: string;
  to: string;
  generatedAt: string;
  ga4: {
    summary: Traffic;
    channels: (Traffic & { channel: string })[];
    sources: (Traffic & { source: string; medium: string })[];
    funnel: { step: string; label: string; users: number }[];
    daily: { date: string; sessions: number; transactions: number; revenue: number }[];
    devices: { device: string; sessions: number; transactions: number }[];
  } | null;
  ga4Error: string | null;
  site: {
    homeSessions: number;
    eventRows: number;
    truncated: boolean;
    slots: (SlotStat & { key: string; label: string; itemLabel: string; items: (SlotStat & { label: string })[]; itemsMore: number })[];
    sessionFunnel: { step: string; label: string; sessions: number }[];
  } | null;
  siteError: string | null;
}

async function fetchReport(secret: string, days: Days): Promise<SiteReport> {
  const res = await fetch(`${ADMIN_API_BASE}/api/site-report?days=${days}`, { headers: { Authorization: `Bearer ${secret}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `불러오기 실패 (${res.status})`);
  return json as SiteReport;
}

// ─── 표기 ────────────────────────────────────────────────────────────────────

const n = (v: number) => v.toLocaleString("ko-KR");
const pct = (a: number, b: number, digits = 1) => (b > 0 ? `${((a / b) * 100).toFixed(digits)}%` : "—");
/** 엔화 — 만 단위는 한국어로(123만 4,500엔), 표에선 exact=true 로 콤마 그대로 */
function yen(v: number, exact = false): string {
  if (exact || v < 10_000) return `${n(v)}엔`;
  const man = Math.floor(v / 10_000);
  const rest = Math.round(v % 10_000);
  return rest ? `${n(man)}만 ${n(rest)}엔` : `${n(man)}만엔`;
}
const ymdDot = (s: string) => s.replace(/-/g, ".");

/** GA4 기본 채널 → 한국어 이름·고정 색(원본 팔레트) */
const CHANNELS: Record<string, { label: string; color: string }> = {
  "Organic Search": { label: "자연 검색", color: "#2a78d6" },
  "Paid Search": { label: "검색 광고", color: "#eb6834" },
  "Organic Social": { label: "소셜", color: "#e87ba4" },
  "Paid Social": { label: "소셜 광고", color: "#e34948" },
  Direct: { label: "직접 유입", color: "#6250d6" },
  Referral: { label: "다른 사이트", color: "#1baf7a" },
  "Organic Shopping": { label: "쇼핑(자연)", color: "#008300" },
  "Paid Shopping": { label: "쇼핑 광고", color: "#008300" },
  Email: { label: "이메일", color: "#eda100" },
  SMS: { label: "SMS", color: "#eda100" },
  "Cross-network": { label: "크로스 네트워크", color: "#eda100" },
  Unassigned: { label: "미분류", color: "#a3a3a3" },
};
const channelInfo = (c: string) => CHANNELS[c] ?? { label: c, color: "#a3a3a3" };
const FUNNEL_RAMP = ["#86b6ef", "#5b97e0", "#3a78c9", "#235da6", "#104281"];

// ─── 그림 조각 ────────────────────────────────────────────────────────────────

function Section({ title, hint, children, className }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        {hint && <p className="text-[11px] text-muted-foreground leading-relaxed">{hint}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-xl font-bold mt-0.5 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function Chip({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: color }} />;
}

/** 100% 누적 막대 한 줄 — 8% 이상 조각만 안에 이름 */
function CompositionBar({ label, parts }: { label: string; parts: { key: string; label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">{label} · {n(total)}</p>
      <div className="flex h-7 w-full gap-[2px] overflow-hidden rounded">
        {total > 0 ? parts.filter((p) => p.value > 0).map((p) => {
          const share = p.value / total;
          return (
            <div
              key={p.key}
              className="h-full flex items-center justify-center text-[10px] font-medium text-white overflow-hidden whitespace-nowrap"
              style={{ width: `${share * 100}%`, background: p.color }}
              title={`${p.label} ${n(p.value)} (${(share * 100).toFixed(1)}%)`}
            >
              {share >= 0.08 && `${p.label} ${(share * 100).toFixed(0)}%`}
            </div>
          );
        }) : <div className="h-full w-full bg-muted" />}
      </div>
    </div>
  );
}

interface HBarRow { key: string; label: string; value: number; display: string; color?: string; sub?: string }

/** 가로 막대 — 회색, 경로 색은 이름 옆 칩만. avg 가 있으면 점선 */
function HBars({ rows, max, avg, avgLabel, selected, onSelect }: {
  rows: HBarRow[];
  max?: number;
  avg?: number;
  avgLabel?: string;
  selected?: string | null;
  onSelect?: (key: string) => void;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value), avg ?? 0);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const active = selected === r.key;
        return (
          <button
            key={r.key}
            type="button"
            disabled={!onSelect}
            onClick={() => onSelect?.(r.key)}
            className={cn("w-full grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-left text-xs group", onSelect && "cursor-pointer")}
          >
            <span className={cn("flex items-center gap-1.5 truncate", active && "font-bold")}>
              {r.color && <Chip color={r.color} />}
              <span className="truncate">{r.label}</span>
            </span>
            <span className="relative h-4 rounded-sm bg-muted/50">
              <span
                className={cn("absolute inset-y-0 left-0 rounded-sm", active ? "bg-neutral-700" : "bg-neutral-400 group-hover:bg-neutral-700")}
                style={{ width: `${Math.min(100, (r.value / top) * 100)}%` }}
              />
              {avg !== undefined && <span className="absolute inset-y-[-3px] border-l border-dashed border-neutral-900/60" style={{ left: `${Math.min(100, (avg / top) * 100)}%` }} />}
            </span>
            <span className="tabular-nums text-right w-24">
              {r.display}
              {r.sub && <span className="text-muted-foreground"> {r.sub}</span>}
            </span>
          </button>
        );
      })}
      {avg !== undefined && avgLabel && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1 pt-0.5">
          <span className="inline-block w-4 border-t border-dashed border-neutral-900/60" />{avgLabel}
        </p>
      )}
    </div>
  );
}

/** 퍼널 — 폭은 1단계 기준, 단계 사이 「다음 단계로 n%」 */
function FunnelBars({ steps }: { steps: { label: string; value: number }[] }) {
  const first = steps[0]?.value ?? 0;
  return (
    <div className="space-y-1">
      {steps.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && (
            <p className="text-[10px] text-muted-foreground pl-[9.5rem]">↓ 다음 단계로 {pct(s.value, steps[i - 1].value)}</p>
          )}
          <div className="grid grid-cols-[9rem_1fr_auto] items-center gap-2 text-xs">
            <span className="truncate">{s.label}</span>
            <span className="h-6 rounded-sm bg-muted/40">
              <span className="block h-full rounded-sm" style={{ width: `${first > 0 ? Math.max(0.5, (s.value / first) * 100) : 0}%`, background: FUNNEL_RAMP[Math.min(i, FUNNEL_RAMP.length - 1)] }} />
            </span>
            <span className="tabular-nums w-24 text-right">{n(s.value)}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function FunnelTable({ steps, unit }: { steps: { label: string; value: number }[]; unit: string }) {
  const first = steps[0]?.value ?? 0;
  return (
    <table className="w-full text-xs mt-3">
      <thead className="text-muted-foreground">
        <tr className="border-b"><th className="text-left py-1 font-normal">단계</th><th className="text-right font-normal">{unit}</th><th className="text-right font-normal">앞 단계 대비</th><th className="text-right font-normal">첫 단계 대비</th></tr>
      </thead>
      <tbody>
        {steps.map((s, i) => (
          <tr key={s.label} className="border-b last:border-0">
            <td className="py-1">{s.label}</td>
            <td className="text-right tabular-nums">{n(s.value)}</td>
            <td className="text-right tabular-nums">{i === 0 ? "—" : pct(s.value, steps[i - 1].value)}</td>
            <td className="text-right tabular-nums font-semibold">{i === 0 ? "—" : pct(s.value, first)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 일별 방문 막대 + 구매 건수 점 */
function DailyBars({ daily }: { daily: NonNullable<SiteReport["ga4"]>["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.sessions));
  return (
    <div>
      <div className="flex items-end gap-[2px] h-28">
        {daily.map((d) => (
          <div key={d.date} className="flex-1 h-full flex flex-col justify-end group relative" title={`${d.date.slice(4, 6)}/${d.date.slice(6)} 방문 ${n(d.sessions)} · 구매 ${n(d.transactions)}건 · ${yen(d.revenue, true)}`}>
            <div className="w-full rounded-t-sm bg-neutral-300 group-hover:bg-neutral-600" style={{ height: `${(d.sessions / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-[2px] mt-1">
        {daily.map((d) => (
          <div key={d.date} className="flex-1 flex justify-center">
            {d.transactions > 0 && <span className="text-[9px] tabular-nums text-[#104281] font-semibold">{d.transactions}</span>}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground flex justify-between mt-0.5">
        <span>{daily[0] && `${daily[0].date.slice(4, 6)}/${daily[0].date.slice(6)}`}</span>
        <span>회색 = 방문 세션 · 숫자 = 그날 구매 건수 (막대에 마우스를 올리면 매출)</span>
        <span>{daily.at(-1) && `${daily.at(-1)!.date.slice(4, 6)}/${daily.at(-1)!.date.slice(6)}`}</span>
      </p>
    </div>
  );
}

// ─── 탭 내용 ─────────────────────────────────────────────────────────────────

function TrafficTab({ ga4 }: { ga4: NonNullable<SiteReport["ga4"]> }) {
  const [showTable, setShowTable] = useState(false);
  const channels = ga4.channels.filter((c) => c.sessions > 0);
  const totalSessions = channels.reduce((s, c) => s + c.sessions, 0);
  const totalTx = channels.reduce((s, c) => s + c.transactions, 0);
  const avgCv = totalSessions > 0 ? totalTx / totalSessions : 0;
  const parts = (pick: (c: (typeof channels)[number]) => number) =>
    channels.map((c) => ({ key: c.channel, label: channelInfo(c.channel).label, value: pick(c), color: channelInfo(c.channel).color }));

  return (
    <div className="space-y-4">
      <Section title="방문은 어디서, 구매는 어디서" hint="같은 채널 색으로 방문 세션 비중과 구매 건수 비중을 나란히. 구매 비중이 방문 비중보다 크면 그 채널 손님이 더 잘 산다는 뜻">
        <div className="space-y-3">
          <CompositionBar label="방문 세션" parts={parts((c) => c.sessions)} />
          <CompositionBar label="구매 건수" parts={parts((c) => c.transactions)} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] pt-1">
            {channels.map((c) => (
              <span key={c.channel} className="flex items-center gap-1"><Chip color={channelInfo(c.channel).color} />{channelInfo(c.channel).label}</span>
            ))}
          </div>
        </div>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="채널별 방문 세션">
          <HBars rows={channels.map((c) => ({ key: c.channel, label: channelInfo(c.channel).label, color: channelInfo(c.channel).color, value: c.sessions, display: n(c.sessions), sub: pct(c.sessions, totalSessions, 0) }))} />
        </Section>
        <Section title="채널별 구매 전환율" hint="구매 건수 ÷ 방문 세션. 점선 = 전체 평균">
          <HBars
            rows={channels.map((c) => ({ key: c.channel, label: channelInfo(c.channel).label, color: channelInfo(c.channel).color, value: c.sessions > 0 ? c.transactions / c.sessions : 0, display: pct(c.transactions, c.sessions, 2), sub: `${n(c.transactions)}건` }))}
            avg={avgCv}
            avgLabel={`전체 평균 ${(avgCv * 100).toFixed(2)}%`}
          />
        </Section>
      </div>

      <Section title="채널 이용 표">
        <button type="button" onClick={() => setShowTable((v) => !v)} className="text-[11px] underline text-muted-foreground mb-2">{showTable ? "표 접기" : "표로 보기"}</button>
        {showTable && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-1 font-normal">채널</th><th className="text-right font-normal">방문 세션</th><th className="text-right font-normal">방문자</th><th className="text-right font-normal">신규</th>
                  <th className="text-right font-normal">장바구니 담기</th><th className="text-right font-normal">구매</th><th className="text-right font-normal">구매 전환율</th><th className="text-right font-normal">매출</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel} className="border-b last:border-0">
                    <td className="py-1"><span className="flex items-center gap-1.5"><Chip color={channelInfo(c.channel).color} />{channelInfo(c.channel).label}</span></td>
                    <td className="text-right tabular-nums">{n(c.sessions)}</td><td className="text-right tabular-nums">{n(c.users)}명</td><td className="text-right tabular-nums">{n(c.newUsers)}명</td>
                    <td className="text-right tabular-nums">{n(c.addToCarts)}회</td><td className="text-right tabular-nums">{n(c.transactions)}건</td>
                    <td className="text-right tabular-nums font-semibold">{pct(c.transactions, c.sessions, 2)}</td><td className="text-right tabular-nums">{yen(c.revenue, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        <Section title="소스·매체 상위 20" hint="UTM 의 utm_source / utm_medium. 라인·인스타 캠페인은 여기서 갈라 봅니다">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[520px]">
              <thead className="text-muted-foreground">
                <tr className="border-b"><th className="text-left py-1 font-normal">소스 / 매체</th><th className="text-right font-normal">방문 세션</th><th className="text-right font-normal">방문자</th><th className="text-right font-normal">구매</th><th className="text-right font-normal">구매 전환율</th><th className="text-right font-normal">매출</th></tr>
              </thead>
              <tbody>
                {ga4.sources.map((s) => (
                  <tr key={`${s.source}/${s.medium}`} className="border-b last:border-0">
                    <td className="py-1 max-w-[16rem] truncate">{s.source} <span className="text-muted-foreground">/ {s.medium}</span></td>
                    <td className="text-right tabular-nums">{n(s.sessions)}</td><td className="text-right tabular-nums">{n(s.users)}명</td><td className="text-right tabular-nums">{n(s.transactions)}건</td>
                    <td className="text-right tabular-nums font-semibold">{pct(s.transactions, s.sessions, 2)}</td><td className="text-right tabular-nums">{yen(s.revenue, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="기기별">
          <HBars rows={ga4.devices.map((d) => ({ key: d.device, label: d.device === "mobile" ? "모바일" : d.device === "desktop" ? "PC" : d.device === "tablet" ? "태블릿" : d.device, value: d.sessions, display: n(d.sessions), sub: `${pct(d.transactions, d.sessions, 2)}` }))} />
          <p className="text-[10px] text-muted-foreground mt-2">숫자 = 방문 세션 · 옆 % = 구매 전환율</p>
        </Section>
      </div>
    </div>
  );
}

function FunnelTab({ ga4, site }: { ga4: SiteReport["ga4"]; site: SiteReport["site"] }) {
  const ga4Steps = (ga4?.funnel ?? []).map((s) => ({ label: s.label, value: s.users }));
  const siteSteps = (site?.sessionFunnel ?? []).map((s) => ({ label: s.label, value: s.sessions }));
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Section title="구매 퍼널 (GA4)" hint="단계별 그 행동을 한 고객 수. GA4 이벤트 합계라 순서를 강제하지 않습니다(상세를 안 보고 바로 담은 고객도 장바구니에 셉니다)">
        {ga4Steps.length ? <><FunnelBars steps={ga4Steps} /><FunnelTable steps={ga4Steps} unit="고객" /></> : <p className="text-xs text-muted-foreground">GA4 를 못 불러왔습니다</p>}
      </Section>
      <Section title="메인 화면에서 주문까지 (자체 이벤트)" hint="한 세션(브라우저 탭) 안에서 앞 단계를 모두 거친 경우만. 메인 구좌를 눌러 산 손님이 얼마나 되는지">
        {siteSteps.length ? <><FunnelBars steps={siteSteps} /><FunnelTable steps={siteSteps} unit="세션" /></> : <p className="text-xs text-muted-foreground">자체 이벤트를 못 불러왔습니다</p>}
      </Section>
    </div>
  );
}

function SlotsTab({ site }: { site: NonNullable<SiteReport["site"]> }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const slots = site.slots;
  const totalClick = slots.reduce((s, x) => s + x.sessions, 0);
  const totalOrder = slots.reduce((s, x) => s + x.orderSessions, 0);
  const avg = totalClick > 0 ? totalOrder / totalClick : 0;
  const detail = slots.find((s) => s.key === picked) ?? null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="구좌별 클릭 세션" hint={`그 구좌를 한 번이라도 누른 세션. 옆 % = 메인 화면 진입 ${n(site.homeSessions)}세션 대비. 행을 누르면 아래에 항목별`}>
          <HBars
            rows={slots.map((s) => ({ key: s.key, label: s.label, value: s.sessions, display: n(s.sessions), sub: pct(s.sessions, site.homeSessions, 1) }))}
            selected={picked}
            onSelect={(k) => setPicked((p) => (p === k ? null : k))}
          />
        </Section>
        <Section title="구좌별 구매 전환율" hint={totalOrder > 0 ? "누른 세션 중 그 뒤 같은 세션에서 주문까지 간 비율. 점선 = 전체 평균" : "아직 구좌와 이어진 주문이 없습니다 — 2026-10-28 배포 이후 주문부터 쌓입니다"}>
          <HBars
            rows={slots.map((s) => ({ key: s.key, label: s.label, value: s.sessions > 0 ? s.orderSessions / s.sessions : 0, display: pct(s.orderSessions, s.sessions, 1), sub: `${n(s.orderSessions)}건` }))}
            avg={avg}
            avgLabel={`전체 평균 ${(avg * 100).toFixed(1)}%`}
            selected={picked}
            onSelect={(k) => setPicked((p) => (p === k ? null : k))}
          />
        </Section>
      </div>

      {detail && (
        <Section title={`${detail.label} — ${detail.itemLabel}별 클릭`} hint="클릭 세션 순 상위 30개">
          {detail.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">이 기간엔 클릭이 없습니다{["affiliate", "affiliate_link", "instagram"].includes(detail.key) ? " — 이 구좌는 10/28 배포 이후부터 셉니다" : ""}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[560px]">
                <thead className="text-muted-foreground">
                  <tr className="border-b"><th className="text-left py-1 font-normal">{detail.itemLabel}</th><th className="text-right font-normal">클릭 세션</th><th className="text-right font-normal">비중</th><th className="text-right font-normal">클릭 수</th><th className="text-right font-normal">결제 시작</th><th className="text-right font-normal">주문</th><th className="text-right font-normal">구매 전환율</th></tr>
                </thead>
                <tbody>
                  {detail.items.map((it) => (
                    <tr key={it.label} className="border-b last:border-0">
                      <td className="py-1 max-w-[20rem] truncate">{it.label}</td>
                      <td className="text-right tabular-nums">{n(it.sessions)}</td><td className="text-right tabular-nums">{pct(it.sessions, detail.sessions, 0)}</td>
                      <td className="text-right tabular-nums">{n(it.clicks)}회</td><td className="text-right tabular-nums">{n(it.checkoutSessions)}</td><td className="text-right tabular-nums">{n(it.orderSessions)}건</td>
                      <td className="text-right tabular-nums font-semibold">{pct(it.orderSessions, it.sessions, 1)}</td>
                    </tr>
                  ))}
                  {detail.itemsMore > 0 && <tr><td colSpan={7} className="py-1 text-muted-foreground">그 외 {n(detail.itemsMore)}개</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      <Section title="구좌 이용 표">
        <button type="button" onClick={() => setShowTable((v) => !v)} className="text-[11px] underline text-muted-foreground mb-2">{showTable ? "표 접기" : "표로 보기"}</button>
        {showTable && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[680px]">
              <thead className="text-muted-foreground">
                <tr className="border-b"><th className="text-left py-1 font-normal">구좌</th><th className="text-right font-normal">클릭 세션</th><th className="text-right font-normal">메인 진입 대비</th><th className="text-right font-normal">클릭 수</th><th className="text-right font-normal">결제 시작</th><th className="text-right font-normal">주문</th><th className="text-right font-normal">구매 전환율</th><th className="text-right font-normal">주문 금액</th></tr>
              </thead>
              <tbody>
                {slots.map((s) => (
                  <tr key={s.key} className="border-b last:border-0">
                    <td className="py-1">{s.label}</td>
                    <td className="text-right tabular-nums">{n(s.sessions)}</td><td className="text-right tabular-nums">{pct(s.sessions, site.homeSessions)}</td>
                    <td className="text-right tabular-nums">{n(s.clicks)}회</td><td className="text-right tabular-nums">{n(s.checkoutSessions)}</td><td className="text-right tabular-nums">{n(s.orderSessions)}건</td>
                    <td className="text-right tabular-nums font-semibold">{pct(s.orderSessions, s.sessions)}</td><td className="text-right tabular-nums">{yen(s.orderValue, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── 탭 본체 ─────────────────────────────────────────────────────────────────

const TABS = [
  { key: "traffic", label: "유입 경로" },
  { key: "funnel", label: "구매 퍼널" },
  { key: "slots", label: "메인 화면 구좌" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function SiteReportTab({ secret }: { secret: string }) {
  const [days, setDays] = useState<Days>(30);
  const [tab, setTab] = useState<TabKey>("traffic");
  const { data, isLoading, error } = useQuery({
    queryKey: ["site-report", days],
    queryFn: () => fetchReport(secret, days),
    staleTime: 10 * 60_000,
  });

  const cards = useMemo(() => {
    if (!data) return null;
    const s = data.ga4?.summary;
    const topSlot = [...(data.site?.slots ?? [])].filter((x) => x.key !== "product_legacy").sort((a, b) => b.sessions - a.sessions)[0];
    const topChannel = [...(data.ga4?.channels ?? [])].sort((a, b) => b.transactions - a.transactions)[0];
    return { s, topSlot, topChannel };
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">사이트 성과</h2>
          <p className="text-[11px] text-muted-foreground">손님이 어디서 들어와, 어디를 눌러, 얼마나 사는지 봅니다 (GA4 + 사이트 자체 클릭 기록)</p>
        </div>
        <div className="flex rounded-md border overflow-hidden text-xs">
          {([7, 30, 90] as Days[]).map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={cn("px-3 py-1.5", days === d ? "bg-neutral-900 text-white" : "hover:bg-muted")}>최근 {d}일</button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-xs text-muted-foreground py-8 text-center">불러오는 중… (처음 여는 기간은 10~30초, 90일은 더 걸릴 수 있습니다)</p>}
      {error && <p className="text-xs text-red-600 py-8 text-center">{error instanceof Error ? error.message : "불러오기 실패"}</p>}

      {data && cards && (
        <>
          <p className="text-[11px] text-muted-foreground">
            집계 기간 {ymdDot(data.from)} ~ {ymdDot(data.to)} (JST, 오늘 제외)
            {data.ga4Error && <span className="text-red-600"> · GA4 오류: {data.ga4Error}</span>}
            {data.siteError && <span className="text-red-600"> · 자체 이벤트 오류: {data.siteError}</span>}
            {data.site?.truncated && <span className="text-amber-700"> · 클릭 기록이 많아 앞 {n(data.site.eventRows)}건까지만 셌습니다</span>}
          </p>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="방문자" value={cards.s ? `${n(cards.s.users)}명` : "—"} hint={cards.s ? `세션 ${n(cards.s.sessions)} · 신규 ${n(cards.s.newUsers)}명` : undefined} />
            <StatCard label="구매" value={cards.s ? `${n(cards.s.transactions)}건` : "—"} hint={cards.s ? `구매 전환율 ${pct(cards.s.transactions, cards.s.sessions, 2)}` : undefined} />
            <StatCard label="매출 (GA4)" value={cards.s ? yen(cards.s.revenue) : "—"} hint={cards.s && cards.s.transactions > 0 ? `객단가 ${yen(Math.round(cards.s.revenue / cards.s.transactions))}` : undefined} />
            <StatCard label="구매가 가장 많은 채널" value={cards.topChannel ? channelInfo(cards.topChannel.channel).label : "—"} hint={cards.topChannel && cards.s ? `구매 ${pct(cards.topChannel.transactions, cards.s.transactions, 0)} · 전환율 ${pct(cards.topChannel.transactions, cards.topChannel.sessions, 2)}` : undefined} />
            <StatCard label="클릭이 가장 많은 메인 구좌" value={cards.topSlot ? cards.topSlot.label : "—"} hint={cards.topSlot && data.site ? `메인 진입의 ${pct(cards.topSlot.sessions, data.site.homeSessions)} · 전환율 ${pct(cards.topSlot.orderSessions, cards.topSlot.sessions)}` : undefined} />
          </div>

          {data.ga4 && data.ga4.daily.length > 0 && (
            <Section title="일별 방문·구매">
              <DailyBars daily={data.ga4.daily} />
            </Section>
          )}

          <div className="flex gap-4 border-b text-sm">
            {TABS.map((t) => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)} className={cn("pb-2 -mb-px border-b-2", tab === t.key ? "border-neutral-900 font-bold" : "border-transparent text-muted-foreground hover:text-foreground")}>{t.label}</button>
            ))}
          </div>

          {tab === "traffic" && (data.ga4 ? <TrafficTab ga4={data.ga4} /> : <p className="text-xs text-muted-foreground">GA4 를 못 불러왔습니다</p>)}
          {tab === "funnel" && <FunnelTab ga4={data.ga4} site={data.site} />}
          {tab === "slots" && (data.site ? <SlotsTab site={data.site} /> : <p className="text-xs text-muted-foreground">자체 이벤트를 못 불러왔습니다</p>)}

          <div className="text-[10px] text-muted-foreground leading-relaxed space-y-0.5 pt-2">
            <p>· 유입 경로·구매 퍼널(GA4)·매출은 GA4 기준입니다. 구매·매출은 Shopify 주문 웹훅이 GA4 로 보낸 값이고, 결제 직전 세션 정보가 없는 주문은 「직접 유입」으로 잡힐 수 있습니다.</p>
            <p>· 메인 화면 구좌는 사이트 자체 클릭 기록입니다. 세션 = 브라우저 탭 하나. 「주문」 = 그 구좌를 누른 뒤 같은 세션(탭)에서 결제한 주문. 결제 때 사이트 세션 번호를 주문에 싣기 시작한 2026-10-28 배포 이후 주문부터 잡히고, 그 전 기간은 0 으로 나옵니다.</p>
            <p>· 어필리에이트 배너·메뉴·푸터 링크, 인스타 릴스, 상품 줄 구분(신상품·카테고리별·인기·전체 목록)은 2026-10-28 배포부터 셉니다. 그 전 상품 클릭은 「상품 클릭 (구좌 구분 전)」에 모입니다.</p>
            <p>· 한 세션이 여러 구좌를 누르면 구좌마다 셉니다(구좌끼리 더하면 중복).</p>
          </div>
        </>
      )}
    </div>
  );
}
