import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 어드민 「어필리에이트」 탭 — Phase 0 (Issue #178)
 *
 * 읽기 전용 장부 + 파트너 수동 등록. 캠페인 생성·정산·이상 감지는 Phase 3.
 * 데이터는 /api/affiliate-admin (Bearer ADMIN_SECRET) 하나로 온다.
 */

const ADMIN_API_BASE = (import.meta.env.VITE_ADMIN_API_BASE_URL as string) ?? "";

interface MonthStats { orders: number; sales: number; pending: number; confirmed: number; self: number }
interface Partner {
  id: number;
  code: string;
  name: string;
  instagram: string | null;
  email: string | null;
  status: "active" | "suspended" | "withdrawn";
  joined_at: string;
  manual: boolean;
  codes: string[];
  month: MonthStats;
}
interface Conversion {
  id: number;
  order_name: string | null;
  partner_code: string;
  attribution: "code" | "ref" | "customer";
  eligible_amount: number;
  rate: number;
  rate_source: string;
  commission: number;
  status: "pending" | "confirmed" | "reversed" | "self" | "void";
  ordered_at: string;
  confirm_at: string;
}
interface Campaign {
  id: number; name: string; starts_at: string; ends_at: string;
  commission_rate: number; discount_percent: number | null; scope: string; target_ids: string[]; active: boolean;
}
interface AffiliateData {
  ok: true;
  enabled: boolean;
  baseRate: number;
  monthStart: string;
  partners: Partner[];
  recent: Conversion[];
  campaigns: Campaign[];
}

async function fetchAffiliate(secret: string): Promise<AffiliateData> {
  const res = await fetch(`${ADMIN_API_BASE}/api/affiliate-admin`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

async function addPartner(secret: string, body: Record<string, string>): Promise<void> {
  const res = await fetch(`${ADMIN_API_BASE}/api/affiliate-admin`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add_partner", ...body }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
const day = (iso: string) => iso.slice(0, 10);

const STATUS_LABEL: Record<Conversion["status"], string> = {
  pending: "확정 대기", confirmed: "확정", reversed: "환불 회수", self: "자기구매", void: "무효",
};
const STATUS_CLASS: Record<Conversion["status"], string> = {
  pending: "bg-amber-50 text-amber-700",
  confirmed: "bg-emerald-50 text-emerald-700",
  reversed: "bg-red-50 text-red-700",
  self: "bg-slate-100 text-slate-600",
  void: "bg-slate-100 text-slate-500",
};
const ATTR_LABEL: Record<Conversion["attribution"], string> = { code: "코드", ref: "링크", customer: "고객" };

function Pill({ children, className }: { children: string; className: string }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>;
}

function AddPartnerForm({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [form, setForm] = useState({ code: "", name: "", instagram: "", email: "", discountCode: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr(null);
    try { await addPartner(secret, form); onDone(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : "오류 발생"); }
    finally { setSaving(false); }
  }

  const input = "h-8 rounded border bg-background px-2 text-xs w-full";
  return (
    <form onSubmit={submit} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
      <label className="text-[11px] text-muted-foreground space-y-1">
        <span>링크 코드 *</span>
        <input className={`${input} font-mono uppercase`} value={form.code} onChange={set("code")} placeholder="HANA7K" required maxLength={12} />
      </label>
      <label className="text-[11px] text-muted-foreground space-y-1">
        <span>이름 *</span>
        <input className={input} value={form.name} onChange={set("name")} placeholder="表示名" required />
      </label>
      <label className="text-[11px] text-muted-foreground space-y-1">
        <span>Instagram</span>
        <input className={input} value={form.instagram} onChange={set("instagram")} placeholder="@handle" />
      </label>
      <label className="text-[11px] text-muted-foreground space-y-1">
        <span>이메일</span>
        <input className={input} type="email" value={form.email} onChange={set("email")} placeholder="자기구매 판정용" />
      </label>
      <label className="text-[11px] text-muted-foreground space-y-1">
        <span>Collabs 할인코드</span>
        <input className={`${input} font-mono uppercase`} value={form.discountCode} onChange={set("discountCode")} placeholder="기존 코드 있으면" />
      </label>
      <button type="submit" disabled={saving} className="h-8 rounded bg-foreground text-background text-xs px-3 disabled:opacity-50">
        {saving ? "저장 중…" : "파트너 추가"}
      </button>
      {err && <p className="col-span-full text-xs text-red-600">{err}</p>}
    </form>
  );
}

export default function AffiliateTab({ secret }: { secret: string }) {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["affiliate-admin", secret],
    queryFn: () => fetchAffiliate(secret),
    staleTime: 60 * 1000,
    retry: (count, err) => !(err instanceof Error && err.message === "UNAUTHORIZED") && count < 2,
  });

  if (isLoading) return <p className="text-xs text-muted-foreground py-8 text-center">불러오는 중…</p>;
  if (isError || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        어필리에이트 데이터 오류: {error instanceof Error ? error.message : "알 수 없는 오류"}
        <p className="text-xs mt-1 text-red-600">테이블이 아직 없으면 Supabase 에 마이그레이션 `20260917000000_affiliate_schema.sql` 이 적용됐는지 확인.</p>
      </div>
    );
  }

  const totals = data.partners.reduce(
    (a, p) => ({ orders: a.orders + p.month.orders, sales: a.sales + p.month.sales, pending: a.pending + p.month.pending, confirmed: a.confirmed + p.month.confirmed }),
    { orders: 0, sales: 0, pending: 0, confirmed: 0 }
  );

  return (
    <div className="space-y-5">
      {/* 상태 띠 */}
      <div className={`rounded-lg border px-4 py-2.5 text-xs flex flex-wrap items-center gap-x-4 gap-y-1 ${data.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
        <span className="font-semibold">{data.enabled ? "● 장부 기록 중" : "○ 꺼짐 — AFFILIATE_ENABLED 미설정"}</span>
        <span>기본 커미션 {pct(data.baseRate)}</span>
        <span>귀속 창 30일 · 확정 대기 30일</span>
        <span className="text-muted-foreground">이달 집계 기준 {day(data.monthStart)} (JST)</span>
      </div>

      {/* 이달 요약 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ["이달 귀속 주문", `${totals.orders}건`],
          ["이달 귀속 매출", yen(totals.sales)],
          ["커미션 확정 대기", yen(totals.pending)],
          ["커미션 확정", yen(totals.confirmed)],
        ].map(([k, v]) => (
          <Card key={k}><CardContent className="p-4">
            <p className="text-[11px] text-muted-foreground">{k}</p>
            <p className="text-lg font-semibold tabular-nums mt-1">{v}</p>
          </CardContent></Card>
        ))}
      </div>

      {/* 파트너 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">파트너 {data.partners.length}명</CardTitle>
          <p className="text-xs text-muted-foreground">Phase 2 셀프 가입 전까지는 여기서 수동 등록. Collabs 할인코드를 함께 넣으면 그 코드 주문이 바로 장부에 잡힌다.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddPartnerForm secret={secret} onDone={() => qc.invalidateQueries({ queryKey: ["affiliate-admin"] })} />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-muted-foreground">
                <tr className="[&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                  <th>코드</th><th>이름</th><th>Instagram</th><th>할인코드</th><th>가입</th>
                  <th className="text-right">이달 주문</th><th className="text-right">이달 매출</th><th className="text-right">확정 대기</th><th className="text-right">확정</th><th>상태</th>
                </tr>
              </thead>
              <tbody>
                {data.partners.length === 0 && (
                  <tr><td colSpan={10} className="py-6 text-center text-muted-foreground">파트너가 없습니다. 위에서 첫 파트너를 추가하세요.</td></tr>
                )}
                {data.partners.map((p) => (
                  <tr key={p.id} className="border-b last:border-0 [&>td]:py-2 [&>td]:align-top">
                    <td className="font-mono font-medium">{p.code}</td>
                    <td>{p.name}{p.manual && <span className="ml-1 text-[10px] text-muted-foreground">수동</span>}</td>
                    <td className="text-muted-foreground">{p.instagram ? `@${p.instagram}` : "—"}</td>
                    <td className="font-mono text-muted-foreground">{p.codes.join(", ") || "—"}</td>
                    <td className="text-muted-foreground">{day(p.joined_at)}</td>
                    <td className="text-right tabular-nums">{p.month.orders}{p.month.self > 0 && <span className="text-muted-foreground"> (자기 {p.month.self})</span>}</td>
                    <td className="text-right tabular-nums">{yen(p.month.sales)}</td>
                    <td className="text-right tabular-nums">{yen(p.month.pending)}</td>
                    <td className="text-right tabular-nums">{yen(p.month.confirmed)}</td>
                    <td>{p.status === "active" ? <Pill className="bg-emerald-50 text-emerald-700">활동</Pill> : <Pill className="bg-slate-100 text-slate-600">{p.status === "suspended" ? "정지" : "탈퇴"}</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 최근 전환 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">최근 귀속 주문 {data.recent.length}건</CardTitle>
          <p className="text-xs text-muted-foreground">주문 웹훅이 판정한 결과 그대로. 요율은 주문 시점 값으로 고정되어 이후 변경에 소급되지 않는다.</p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>주문</th><th>주문일</th><th>파트너</th><th>귀속</th><th className="text-right">기준액</th><th className="text-right">요율</th><th className="text-right">커미션</th><th>상태</th><th>확정 예정</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.length === 0 && (
                <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">아직 귀속된 주문이 없습니다.</td></tr>
              )}
              {data.recent.map((c) => (
                <tr key={c.id} className="border-b last:border-0 [&>td]:py-2">
                  <td className="font-mono">{c.order_name ?? "—"}</td>
                  <td className="text-muted-foreground">{day(c.ordered_at)}</td>
                  <td className="font-mono">{c.partner_code}</td>
                  <td>{ATTR_LABEL[c.attribution]}</td>
                  <td className="text-right tabular-nums">{yen(c.eligible_amount)}</td>
                  <td className="text-right tabular-nums" title={c.rate_source}>{pct(Number(c.rate))}{c.rate_source !== "base" && "*"}</td>
                  <td className="text-right tabular-nums font-medium">{yen(c.commission)}</td>
                  <td><Pill className={STATUS_CLASS[c.status]}>{STATUS_LABEL[c.status]}</Pill></td>
                  <td className="text-muted-foreground">{day(c.confirm_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.recent.some((c) => c.rate_source !== "base") && (
            <p className="text-[11px] text-muted-foreground mt-2">* 캠페인 요율 적용</p>
          )}
        </CardContent>
      </Card>

      {/* 캠페인 (읽기 전용) */}
      {data.campaigns.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">캠페인 {data.campaigns.length}건</CardTitle>
            <p className="text-xs text-muted-foreground">생성·수정은 Phase 3 에서. 지금은 「Collabs 이행 코드」 시스템 캠페인만 자동으로 생긴다.</p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-muted-foreground">
                <tr className="[&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                  <th>이름</th><th>기간</th><th>대상</th><th className="text-right">커미션</th><th className="text-right">고객 할인</th><th>상태</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 [&>td]:py-2">
                    <td>{c.name}</td>
                    <td className="text-muted-foreground">{day(c.starts_at)} ~ {c.ends_at.startsWith("2099") ? "종료 없음" : day(c.ends_at)}</td>
                    <td className="text-muted-foreground">{c.scope === "all" ? "전원" : c.scope === "partners" ? `파트너 ${c.target_ids.length}명` : `상품 ${c.target_ids.length}개`}</td>
                    <td className="text-right tabular-nums">{pct(Number(c.commission_rate))}</td>
                    <td className="text-right tabular-nums">{c.discount_percent != null ? `${c.discount_percent}%` : "—"}</td>
                    <td>{c.active ? <Pill className="bg-emerald-50 text-emerald-700">진행</Pill> : <Pill className="bg-slate-100 text-slate-600">종료</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
