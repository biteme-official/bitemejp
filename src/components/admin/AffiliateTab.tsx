import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 어드민 「어필리에이트」 탭 (Issue #178)
 *
 * 장부 + 파트너 현황(성과순) + 캠페인 만들기·종료(Phase 3). 정산·이상 감지는 다음 PR.
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
  total: MonthStats;
  monthClicks: number;
  shopify_customer_id: string | null;
  terms_version: string;
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
  status: "pending" | "confirmed" | "reversed" | "self" | "void" | "nonmember";
  ordered_at: string;
  confirm_at: string;
}
interface Campaign {
  id: number; name: string; starts_at: string; ends_at: string;
  commission_rate: number; discount_percent: number | null; scope: string; target_ids: string[]; active: boolean;
  created_by: string | null;
  codes: Array<{ partnerId: number; partnerCode: string; code: string; status: string }>;
  result: { orders: number; sales: number; commission: number };
}
interface CreateResult {
  codes: Array<{ partnerCode: string; code: string }>;
  codeErrors: Array<{ partnerCode: string; error: string }>;
  notified: { sent: number; notFriend: number; failed: number };
}
interface AffiliateData {
  ok: true;
  enabled: boolean;
  baseRate: number;
  monthStart: string;
  /** 회원 한정이 거른 비회원 주문 — 이달 건수·매출 (커미션은 항상 0) */
  nonmember: { orders: number; sales: number };
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

async function postAdmin<T = unknown>(secret: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${ADMIN_API_BASE}/api/affiliate-admin`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}
const addPartner = (secret: string, body: Record<string, string>) => postAdmin(secret, { action: "add_partner", ...body });

/** 상태 셀 — 활동/정지/탈퇴 전환 + 장부 0건이면 삭제 (테스트 파트너 정리용) */
function PartnerActions({ secret, partner, onDone }: { secret: string; partner: Partner; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try { await postAdmin(secret, body); onDone(); }
    catch (e) { alert(e instanceof Error ? e.message : "실패"); }
    finally { setBusy(false); }
  };
  const btn = "underline disabled:opacity-40";
  return (
    <span className="inline-flex gap-2 text-[11px] text-muted-foreground">
      {partner.status !== "active" && <button className={btn} disabled={busy} onClick={() => run({ action: "set_status", partnerId: partner.id, status: "active" })}>활동</button>}
      {partner.status !== "suspended" && <button className={btn} disabled={busy} onClick={() => run({ action: "set_status", partnerId: partner.id, status: "suspended" }, `${partner.code} 를 정지합니다. 살아 있는 터치가 지워지고 링크가 죽습니다.`)}>정지</button>}
      {partner.status !== "withdrawn" && <button className={btn} disabled={busy} onClick={() => run({ action: "set_status", partnerId: partner.id, status: "withdrawn" }, `${partner.code} 를 탈퇴 처리합니다.`)}>탈퇴</button>}
      <button className={`${btn} text-red-600`} disabled={busy} onClick={() => run({ action: "delete_partner", partnerId: partner.id }, `${partner.code} 를 삭제합니다. 장부에 주문이 있으면 거절됩니다.`)}>삭제</button>
    </span>
  );
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
const day = (iso: string) => iso.slice(0, 10);

const STATUS_LABEL: Record<Conversion["status"], string> = {
  pending: "확정 대기", confirmed: "확정", reversed: "환불 회수", self: "자기구매", void: "무효", nonmember: "비회원",
};
const STATUS_CLASS: Record<Conversion["status"], string> = {
  pending: "bg-amber-50 text-amber-700",
  confirmed: "bg-emerald-50 text-emerald-700",
  reversed: "bg-red-50 text-red-700",
  self: "bg-slate-100 text-slate-600",
  void: "bg-slate-100 text-slate-500",
  nonmember: "bg-slate-100 text-slate-500",
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

/** datetime-local 입력값(JST 벽시계) ↔ ISO */
const toLocalInput = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => new Date(`${v}:00+09:00`).toISOString();

type Scope = "all" | "partners" | "products";

function CampaignForm({ secret, partners, selected, onDone }: {
  secret: string;
  partners: Partner[];
  selected: number[];
  onDone: () => void;
}) {
  const [form, setForm] = useState(() => {
    const now = new Date();
    return {
      name: "",
      startsAt: toLocalInput(now),
      endsAt: toLocalInput(new Date(now.getTime() + 14 * 86400_000)),
      scope: (selected.length > 0 ? "partners" : "all") as Scope,
      products: "",
      commission: "15",
      discount: "",
      usageLimit: "100",
      notify: true,
    };
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const targets = partners.filter((p) => selected.includes(p.id));
  const activeCount = partners.filter((p) => p.status === "active").length;
  const hasDiscount = form.scope === "partners" && form.discount.trim() !== "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setResult(null);
    if (form.scope === "partners" && targets.length === 0) { setErr("아래 파트너 표에서 대상을 체크하세요."); return; }
    const who = form.scope === "all" ? `활동 파트너 전원(${activeCount}명)` : form.scope === "partners" ? targets.map((t) => t.code).join(", ") : "지정 상품";
    const msg = [
      `「${form.name}」 캠페인을 만듭니다.`,
      `대상: ${who} · 커미션 ${form.commission}%${hasDiscount ? ` · 고객 할인 ${form.discount}% (Shopify 전용 코드 ${targets.length}개 생성)` : ""}`,
      form.notify ? "대상 파트너에게 LINE 으로 바로 알림이 갑니다." : "LINE 알림은 보내지 않습니다.",
    ].join("\n");
    if (!window.confirm(msg)) return;
    setSaving(true);
    try {
      const r = await postAdmin<CreateResult>(secret, {
        action: "create_campaign",
        name: form.name,
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
        scope: form.scope,
        targetIds: form.scope === "partners" ? targets.map((t) => String(t.id)) : form.scope === "products" ? form.products.split(/[\s,]+/).filter(Boolean) : [],
        commissionRate: Number(form.commission) / 100,
        discountPercent: hasDiscount ? Number(form.discount) : null,
        usageLimit: Number(form.usageLimit),
        notify: form.notify,
      });
      setResult(r);
      onDone();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "오류 발생");
    } finally {
      setSaving(false);
    }
  }

  const input = "h-8 rounded border bg-background px-2 text-xs w-full";
  const label = "text-[11px] text-muted-foreground space-y-1 block";
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <label className={`${label} col-span-2`}>
          <span>캠페인 이름 * — 파트너 LINE 알림에 그대로 나가니 일본어로</span>
          <input className={input} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="秋の特別キャンペーン" required />
        </label>
        <label className={label}>
          <span>시작 (JST)</span>
          <input type="datetime-local" className={input} value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} required />
        </label>
        <label className={label}>
          <span>종료 (JST)</span>
          <input type="datetime-local" className={input} value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} required />
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-xs">
        {([
          ["all", `활동 파트너 전원 (${activeCount}명)`],
          ["partners", `지정 파트너 — 아래 표에서 체크 (${targets.length}명)`],
          ["products", "지정 상품 — 전원 대상"],
        ] as Array<[Scope, string]>).map(([v, t]) => (
          <label key={v} className="inline-flex items-center gap-1.5">
            <input type="radio" name="scope" checked={form.scope === v} onChange={() => set("scope", v)} />
            {t}
          </label>
        ))}
      </div>
      {form.scope === "partners" && targets.length > 0 && (
        <p className="text-[11px] text-muted-foreground">대상: <span className="font-mono">{targets.map((t) => t.code).join(", ")}</span></p>
      )}
      {form.scope === "products" && (
        <label className={label}>
          <span>상품 — 상품 페이지 URL 을 줄마다 하나씩 (biteme.co.jp/product/…)</span>
          <textarea className="w-full rounded border bg-background px-2 py-1.5 text-xs h-20 font-mono" value={form.products} onChange={(e) => set("products", e.target.value)} />
        </label>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
        <label className={label}>
          <span>커미션율 % (기본 10)</span>
          <input type="number" min={1} max={50} step={0.5} className={input} value={form.commission} onChange={(e) => set("commission", e.target.value)} required />
        </label>
        <label className={label}>
          <span>고객 할인율 %{form.scope !== "partners" && " — 지정 파트너만"}</span>
          <input type="number" min={1} max={50} className={input} value={form.scope === "partners" ? form.discount : ""} onChange={(e) => set("discount", e.target.value)} placeholder="없음" disabled={form.scope !== "partners"} />
        </label>
        <label className={label}>
          <span>코드 사용 상한 (코드당)</span>
          <input type="number" min={1} max={10000} className={input} value={form.usageLimit} onChange={(e) => set("usageLimit", e.target.value)} disabled={!hasDiscount} />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs h-8">
          <input type="checkbox" checked={form.notify} onChange={(e) => set("notify", e.target.checked)} />
          대상 파트너에게 LINE 알림
        </label>
      </div>
      {hasDiscount && (
        <p className="text-[11px] text-muted-foreground">
          파트너마다 Shopify 전용 코드(예: <span className="font-mono">{targets[0]?.code ?? "76D436"}-{form.discount}OFF</span>)가 생깁니다 — 1인 1회, 코드당 {form.usageLimit}회까지, 다른 할인코드와 중복 불가.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="h-8 rounded bg-foreground text-background text-xs px-4 disabled:opacity-50">
          {saving ? "만드는 중…" : "캠페인 만들기"}
        </button>
        {err && <p className="text-xs text-red-600">{err}</p>}
      </div>

      {result && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 space-y-1">
          <p className="font-semibold">캠페인을 만들었습니다.</p>
          {result.codes.length > 0 && <p>전용 코드: <span className="font-mono">{result.codes.map((c) => `${c.partnerCode} → ${c.code}`).join(" · ")}</span></p>}
          {result.codeErrors.length > 0 && <p className="text-red-700">코드 실패: {result.codeErrors.map((c) => `${c.partnerCode} (${c.error})`).join(" · ")}</p>}
          {form.notify && <p>LINE 알림: 보냄 {result.notified.sent} · 친구 아님 {result.notified.notFriend} · 실패 {result.notified.failed}</p>}
        </div>
      )}
    </form>
  );
}

function CampaignList({ secret, campaigns, onDone }: { secret: string; campaigns: Campaign[]; onDone: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const end = async (c: Campaign) => {
    const codeNote = c.codes.some((k) => k.status === "active") ? " 전용 코드도 Shopify 에서 바로 비활성화됩니다." : "";
    if (!window.confirm(`「${c.name}」 를 지금 종료합니다. 이미 난 주문은 캠페인 요율 그대로입니다.${codeNote}`)) return;
    setBusy(c.id);
    try { await postAdmin(secret, { action: "end_campaign", campaignId: c.id }); onDone(); }
    catch (e) { alert(e instanceof Error ? e.message : "실패"); }
    finally { setBusy(null); }
  };
  const now = Date.now();
  const stateOf = (c: Campaign) =>
    !c.active || new Date(c.ends_at).getTime() <= now ? "ended" : new Date(c.starts_at).getTime() > now ? "scheduled" : "live";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="border-b text-muted-foreground">
          <tr className="[&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>이름</th><th>기간</th><th>대상</th><th className="text-right">커미션</th><th className="text-right">고객 할인</th><th>전용 코드</th>
            <th className="text-right">주문</th><th className="text-right">매출</th><th className="text-right">커미션 합</th><th>상태</th><th></th>
          </tr>
        </thead>
        <tbody>
          {campaigns.length === 0 && (
            <tr><td colSpan={11} className="py-6 text-center text-muted-foreground">아직 캠페인이 없습니다.</td></tr>
          )}
          {campaigns.map((c) => {
            const st = stateOf(c);
            return (
              <tr key={c.id} className="border-b last:border-0 [&>td]:py-2 [&>td]:align-top">
                <td>{c.name}</td>
                <td className="text-muted-foreground whitespace-nowrap">{day(c.starts_at)} ~ {c.ends_at.startsWith("2099") ? "종료 없음" : day(c.ends_at)}</td>
                <td className="text-muted-foreground">{c.scope === "all" ? "전원" : c.scope === "partners" ? `파트너 ${c.target_ids.length}명` : `상품 ${c.target_ids.length}개`}</td>
                <td className="text-right tabular-nums">{pct(Number(c.commission_rate))}</td>
                <td className="text-right tabular-nums">{c.discount_percent != null ? `${Number(c.discount_percent)}%` : "—"}</td>
                <td className="font-mono text-muted-foreground">{c.codes.length ? c.codes.map((k) => k.code).join(", ") : "—"}</td>
                <td className="text-right tabular-nums">{c.result.orders}</td>
                <td className="text-right tabular-nums">{yen(c.result.sales)}</td>
                <td className="text-right tabular-nums">{yen(c.result.commission)}</td>
                <td>
                  {st === "live" && <Pill className="bg-emerald-50 text-emerald-700">진행</Pill>}
                  {st === "scheduled" && <Pill className="bg-sky-50 text-sky-700">예정</Pill>}
                  {st === "ended" && <Pill className="bg-slate-100 text-slate-600">종료</Pill>}
                </td>
                <td>
                  {st !== "ended" && c.created_by !== "system" && (
                    <button className="text-[11px] underline text-muted-foreground disabled:opacity-40" disabled={busy === c.id} onClick={() => end(c)}>종료</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground mt-2">주문·매출·커미션 합 = 그 캠페인 요율이 적용된 확정 대기+확정 건.</p>
    </div>
  );
}

export default function AffiliateTab({ secret }: { secret: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number[]>([]);
  const [showForm, setShowForm] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["affiliate-admin"] });
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

  // 성과순 — 이달 매출 → 누적 매출 → 이달 클릭
  const sorted = [...data.partners].sort((a, b) => b.month.sales - a.month.sales || b.total.sales - a.total.sales || b.monthClicks - a.monthClicks);
  const toggle = (id: number) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
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
        <span>회원(LINE 로그인) 주문만 커미션</span>
        <span className="text-muted-foreground">이달 집계 기준 {day(data.monthStart)} (JST)</span>
      </div>

      {/* 이달 요약 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          ["이달 귀속 주문", `${totals.orders}건`],
          ["이달 귀속 매출", yen(totals.sales)],
          ["커미션 확정 대기", yen(totals.pending)],
          ["커미션 확정", yen(totals.confirmed)],
          ["비회원이라 제외", `${data.nonmember.orders}건 · ${yen(data.nonmember.sales)}`],
        ].map(([k, v]) => (
          <Card key={k}><CardContent className="p-4">
            <p className="text-[11px] text-muted-foreground">{k}</p>
            <p className="text-lg font-semibold tabular-nums mt-1">{v}</p>
          </CardContent></Card>
        ))}
      </div>

      {/* 캠페인 */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-sm">캠페인 {data.campaigns.length}건</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">우대의 유일한 입구. 저장하면 끝 — 파트너 수락 단계 없음. 캠페인이 겹치면 가장 높은 요율이 적용된다.</p>
          </div>
          <button className="h-8 shrink-0 rounded border text-xs px-3" onClick={() => setShowForm((v) => !v)}>{showForm ? "닫기" : "캠페인 만들기"}</button>
        </CardHeader>
        <CardContent className="space-y-5">
          {showForm && (
            <div className="rounded-lg border bg-muted/30 p-4">
              <CampaignForm key={selected.join(",")} secret={secret} partners={data.partners} selected={selected} onDone={refresh} />
            </div>
          )}
          <CampaignList secret={secret} campaigns={data.campaigns} onDone={refresh} />
        </CardContent>
      </Card>

      {/* 파트너 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">파트너 {data.partners.length}명 <span className="font-normal text-muted-foreground">· 활동 {data.partners.filter((p) => p.status === "active").length}명</span></CardTitle>
          <p className="text-xs text-muted-foreground">이달 매출순. 체크한 파트너로 「지정 파트너」 캠페인을 만든다. 클릭은 이달·봇 제외, 커미션은 확정 대기+확정.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {selected.length > 0 && (
            <div className="flex items-center gap-3 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              <span>{selected.length}명 선택</span>
              <button className="underline" onClick={() => setShowForm(true)}>이 파트너로 캠페인 만들기 ↑</button>
              <button className="underline text-muted-foreground" onClick={() => setSelected([])}>선택 해제</button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-muted-foreground">
                <tr className="[&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                  <th></th><th>코드</th><th>이름</th><th>Instagram</th><th>가입</th>
                  <th className="text-right">이달 클릭</th><th className="text-right">이달 주문</th><th className="text-right">이달 매출</th><th className="text-right">이달 커미션</th>
                  <th className="text-right">누적 주문</th><th className="text-right">누적 매출</th><th className="text-right">누적 커미션</th>
                  <th>전용 코드</th><th>상태</th><th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr><td colSpan={15} className="py-6 text-center text-muted-foreground">파트너가 없습니다. 셀프 가입(/affiliate · 상품 상세)으로 들어옵니다.</td></tr>
                )}
                {sorted.map((p) => (
                  <tr key={p.id} className={`border-b last:border-0 [&>td]:py-2 [&>td]:align-top ${selected.includes(p.id) ? "bg-sky-50/60" : ""}`}>
                    <td><input type="checkbox" aria-label={`${p.code} 선택`} checked={selected.includes(p.id)} disabled={p.status !== "active"} onChange={() => toggle(p.id)} /></td>
                    <td className="font-mono font-medium">{p.code}</td>
                    <td>
                      {p.name}
                      {p.manual && <span className="ml-1 text-[10px] text-muted-foreground">수동</span>}
                      {!p.manual && !p.shopify_customer_id && <span className="ml-1 text-[10px] text-amber-700" title="Shopify 고객 연결이 없어 자기구매·고객 귀속 판정이 약하다">⚠ 고객 미연결</span>}
                    </td>
                    <td className="text-muted-foreground">{p.instagram ? `@${p.instagram}` : "—"}</td>
                    <td className="text-muted-foreground whitespace-nowrap">{day(p.joined_at)}</td>
                    <td className="text-right tabular-nums">{p.monthClicks}</td>
                    <td className="text-right tabular-nums">{p.month.orders}{p.month.self > 0 && <span className="text-muted-foreground"> (자기 {p.month.self})</span>}</td>
                    <td className="text-right tabular-nums">{yen(p.month.sales)}</td>
                    <td className="text-right tabular-nums">{yen(p.month.pending + p.month.confirmed)}</td>
                    <td className="text-right tabular-nums">{p.total.orders}</td>
                    <td className="text-right tabular-nums">{yen(p.total.sales)}</td>
                    <td className="text-right tabular-nums">{yen(p.total.pending + p.total.confirmed)}</td>
                    <td className="font-mono text-muted-foreground">{p.codes.join(", ") || "—"}</td>
                    <td>{p.status === "active" ? <Pill className="bg-emerald-50 text-emerald-700">활동</Pill> : <Pill className="bg-slate-100 text-slate-600">{p.status === "suspended" ? "정지" : "탈퇴"}</Pill>}</td>
                    <td><PartnerActions secret={secret} partner={p} onDone={refresh} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">수동 등록 (LINE 가입이 안 되는 예외용)</summary>
            <div className="pt-3"><AddPartnerForm secret={secret} onDone={refresh} /></div>
          </details>
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

    </div>
  );
}
