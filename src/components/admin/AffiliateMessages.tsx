import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 어드민 어필리에이트 탭 — 「파트너 메시지」 (Issue #272)
 *
 * 프로모션 센터 「메일 발송」 탭처럼 상황(종류)별로 운영한다. 하위 탭 세 개:
 *   보내기      — 상황 고르기 → 받는 사람(상황 규칙) → 문구(변수) → 미리 보기 → 보내기
 *   상황별 설정 — 상황마다 받는 사람 규칙·다시 보내는 간격·저장 문구·마지막 발송
 *   발송 내역   — 보낸·보류 메시지, 보류는 취소
 * 상황 정의는 서버(api/_affiliate-message-kinds.ts)가 GET 으로 내려준다 — 화면에 사본을 두지 않는다.
 * 1차는 전부 수동 발송. 자동(하루 전 예약)은 2차.
 */

const ADMIN_API_BASE = (import.meta.env.VITE_ADMIN_API_BASE_URL as string) ?? "";

export type GapRule = { type: "once" } | { type: "days"; days: number } | { type: "param" } | { type: "filter" };
export interface MessageKindView {
  kind: string;
  group: string;
  label: string;
  audience: string;
  gap: GapRule;
  param: "filter" | "month" | "period" | null;
  variables: string[];
  defaultBody: string;
  body: string;
  customized: boolean;
  savedAt: string | null;
  lastSentAt: string | null;
  lastCount: number;
}
export interface MessageKindsData { kinds: MessageKindView[]; defaultMonth: string; periods: string[] }
interface MessageFilter { noClicks: boolean; noSales: boolean; joinedDaysMin: number; skipMessagedDays: number }
interface MessageParams { filter?: MessageFilter; month?: string; period?: string }
export interface PartnerMessage {
  id: number; kind?: string; memo: string; body: string; filter: MessageParams | MessageFilter; partner_ids: number[];
  notify_status: "pending" | "sent" | "failed"; sent_count: number; failed_count: number;
  notified_at: string | null; created_at: string;
}
interface PreviewRow { id: number; code: string; name: string; instagram: string | null; joined_at: string; text: string }

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

const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const monthLabel = (p: string) => `${p.slice(0, 4)}년 ${Number(p.slice(5))}월`;
const gapText = (g: GapRule) =>
  g.type === "once" ? "한 번만" : g.type === "days" ? `같은 상황 ${g.days}일 간격` : g.type === "param" ? "같은 달로 한 번만" : "화면에서 고름";

function Pill({ children, className }: { children: string; className: string }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>;
}

/** 보낸 메시지의 상황별 값 요약 — #271 로 만든 옛 행은 filter 가 바로 조건이다 */
function paramsText(m: PartnerMessage, clickDays: number): string {
  const p = m.filter as MessageParams & Partial<MessageFilter>;
  if (p.month) return monthLabel(p.month);
  if (p.period) return `${monthLabel(p.period)} 정산`;
  const f = p.filter ?? (typeof p.noClicks === "boolean" ? (p as MessageFilter) : null);
  if (!f) return "";
  return [
    f.noClicks && `최근 ${clickDays}일 클릭 0`,
    f.noSales && "판매 0",
    f.joinedDaysMin > 0 && `가입 ${f.joinedDaysMin}일 지남`,
    f.skipMessagedDays > 0 && `최근 ${f.skipMessagedDays}일 받은 사람 제외`,
  ].filter(Boolean).join(" · ") || "활동 파트너 전원";
}

// ── 보내기 ────────────────────────────────────────────────────────────────────

function Composer({ secret, data, rules, initialKind, onSent, onTemplateSaved }: {
  secret: string; data: MessageKindsData; rules: { clickWindowDays: number; maxLength: number };
  initialKind: string; onSent: (msg: string) => void; onTemplateSaved: () => void;
}) {
  const [kind, setKind] = useState(initialKind);
  const def = data.kinds.find((k) => k.kind === kind) ?? data.kinds[0];
  const [body, setBody] = useState(def.body);
  const [filter, setFilter] = useState<MessageFilter>({ noClicks: true, noSales: true, joinedDaysMin: 7, skipMessagedDays: 14 });
  const [month, setMonth] = useState(data.defaultMonth);
  const [period, setPeriod] = useState(data.periods[0] ?? "");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // 상황을 바꾸면 그 상황의 저장 문구로 — 미리 보기는 무효
  useEffect(() => { setKind(initialKind); }, [initialKind]);
  useEffect(() => { setBody(def.body); setPreview(null); setMsg(null); }, [def.kind, def.body]);

  const params: MessageParams = def.param === "filter" ? { filter } : def.param === "month" ? { month } : def.param === "period" ? { period } : {};
  const invalidate = () => setPreview(null);
  const setF = <K extends keyof MessageFilter>(k: K, v: MessageFilter[K]) => { setFilter((f) => ({ ...f, [k]: v })); invalidate(); };
  const tooLong = body.length > rules.maxLength;
  const edited = body !== def.body;

  const insertVar = (v: string) => {
    const el = textRef.current;
    const token = `{{${v}}}`;
    if (!el) { setBody((b) => b + token); invalidate(); return; }
    const { selectionStart: s, selectionEnd: e } = el;
    const next = body.slice(0, s) + token + body.slice(e);
    setBody(next); invalidate();
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
  };

  async function runPreview() {
    setBusy(true); setMsg(null);
    try {
      const r = await postAdmin<{ recipients: PreviewRow[] }>(secret, { action: "preview_message", kind: def.kind, params, body });
      setPreview(r.recipients); setFocus(0);
    } catch (ex) { setMsg(ex instanceof Error ? ex.message : "실패"); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!preview) return;
    if (!window.confirm(`「${def.label}」 ${preview.length}명에게 LINE 을 보냅니다 (야간이면 다음 날 09:05).\n보낸 메시지는 취소할 수 없습니다.`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postAdmin<{ notified: { sent: number; failed: number }; notifyPending: boolean }>(secret, {
        action: "send_message", kind: def.kind, params, body, memo: def.label, expectedCount: preview.length,
      });
      setPreview(null);
      onSent(r.notifyPending ? `「${def.label}」 저장했습니다. 야간이라 LINE 은 내일 09:05 에 갑니다.`
        : r.notified.failed > 0 && r.notified.sent === 0 ? `「${def.label}」 저장했지만 발송에 실패했습니다 — 내일 09:05 에 다시 보냅니다.`
          : `「${def.label}」 LINE 을 보냈습니다 (${r.notified.sent}명).`);
    } catch (ex) { setMsg(ex instanceof Error ? ex.message : "실패"); }
    finally { setBusy(false); }
  }

  async function saveTemplate() {
    if (!window.confirm(`이 문구를 「${def.label}」의 기본 문구로 저장합니다. 다음부터 이 상황을 고르면 이 문구로 시작합니다.`)) return;
    setBusy(true); setMsg(null);
    try { await postAdmin(secret, { action: "save_message_template", kind: def.kind, body }); setMsg("문구를 저장했습니다."); onTemplateSaved(); }
    catch (ex) { setMsg(ex instanceof Error ? ex.message : "실패"); }
    finally { setBusy(false); }
  }

  const groups = [...new Set(data.kinds.map((k) => k.group))];
  const input = "h-8 rounded border bg-background px-2 text-xs";
  const check = "flex items-center gap-1.5 text-xs";
  const step = "text-[11px] font-semibold text-muted-foreground";
  const focused = preview?.[focus];

  return (
    <div className="space-y-5">
      {/* 1. 상황 */}
      <section className="space-y-2">
        <p className={step}>1. 어떤 상황인가요</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {groups.map((g) => (
            <div key={g} className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground">{g}</p>
              {data.kinds.filter((k) => k.group === g).map((k) => (
                <button key={k.kind} type="button" onClick={() => setKind(k.kind)}
                  className={`w-full rounded border px-3 py-2 text-left text-xs ${k.kind === def.kind ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted"}`}>
                  <span className="font-medium">{k.label}</span>
                  <span className={`block text-[11px] ${k.kind === def.kind ? "opacity-80" : "text-muted-foreground"}`}>
                    {k.lastSentAt ? `마지막 ${jstDay(k.lastSentAt)} · ${k.lastCount}명` : "아직 안 보냄"}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">캠페인 안내는 아래 「캠페인」에서 캠페인을 만들 때 대상 파트너에게 따로 나갑니다(기존 그대로).</p>
      </section>

      {/* 2. 받는 사람 */}
      <section className="space-y-2">
        <p className={step}>2. 받는 사람</p>
        <p className="text-xs">{def.audience} <span className="text-muted-foreground">· 다시 보내기: {gapText(def.gap)}</span></p>
        {def.param === "filter" && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className={check}><input type="checkbox" checked={filter.noClicks} onChange={(e) => setF("noClicks", e.target.checked)} />최근 {rules.clickWindowDays}일 클릭 0</label>
            <label className={check}><input type="checkbox" checked={filter.noSales} onChange={(e) => setF("noSales", e.target.checked)} />판매 0건</label>
            <label className={check}>가입
              <input type="number" min={0} max={365} className={`${input} w-14`} value={filter.joinedDaysMin} onChange={(e) => setF("joinedDaysMin", Number(e.target.value) || 0)} />일 지남</label>
            <label className={check}>최근
              <input type="number" min={0} max={365} className={`${input} w-14`} value={filter.skipMessagedDays} onChange={(e) => setF("skipMessagedDays", Number(e.target.value) || 0)} />일 안에 메시지 받은 사람 제외</label>
          </div>
        )}
        {def.param === "month" && (
          <label className={check}>대상 월
            <input type="month" className={input} value={month} onChange={(e) => { setMonth(e.target.value); invalidate(); }} />
          </label>
        )}
        {def.param === "period" && (data.periods.length === 0
          ? <p className="text-xs text-amber-700">아직 마감한 정산 월이 없습니다 — 「정산」에서 월 마감을 하면 고를 수 있습니다.</p>
          : (
            <label className={check}>정산 월
              <select className={input} value={period} onChange={(e) => { setPeriod(e.target.value); invalidate(); }}>
                {data.periods.map((p) => <option key={p} value={p}>{monthLabel(p)}</option>)}
              </select>
            </label>
          ))}
      </section>

      {/* 3. 문구 */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className={step}>3. 문구 (일본어 — 변수는 사람마다 채워짐)</p>
          <span className={`text-[11px] ${tooLong ? "text-red-600" : "text-muted-foreground"}`}>{body.length.toLocaleString()} / {rules.maxLength.toLocaleString()}자</span>
          {def.customized && <Pill className="bg-sky-50 text-sky-700">저장한 문구</Pill>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {def.variables.map((v) => (
            <button key={v} type="button" onClick={() => insertVar(v)} className="rounded border bg-background px-2 py-0.5 font-mono text-[11px] hover:bg-muted">{`{{${v}}}`}</button>
          ))}
        </div>
        <textarea ref={textRef} className="w-full rounded border bg-background px-2 py-1.5 text-xs h-72 font-mono leading-relaxed" value={body} onChange={(e) => { setBody(e.target.value); invalidate(); }} />
        <div className="flex flex-wrap gap-3 text-xs">
          <button type="button" disabled={busy || !edited || tooLong} onClick={saveTemplate} className="underline disabled:opacity-40 disabled:no-underline">이 문구를 상황 기본으로 저장</button>
          <button type="button" disabled={!edited} onClick={() => { setBody(def.body); invalidate(); }} className="underline disabled:opacity-40 disabled:no-underline">고친 것 되돌리기</button>
        </div>
      </section>

      {/* 4. 미리 보기 · 보내기 */}
      <section className="space-y-2">
        <p className={step}>4. 미리 보기 후 보내기</p>
        {preview && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded border bg-background px-3 py-2 text-xs space-y-2">
              <p className="font-medium">받는 사람 {preview.length}명 <span className="font-normal text-muted-foreground">— 줄을 누르면 그 사람이 받을 문구</span></p>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[11px]">
                  <thead className="text-muted-foreground text-left"><tr><th className="py-1 pr-3 font-normal">코드</th><th className="pr-3 font-normal">이름</th><th className="pr-3 font-normal">인스타</th><th className="font-normal">가입일</th></tr></thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={r.id} onClick={() => setFocus(i)} className={`border-t cursor-pointer ${i === focus ? "bg-muted" : "hover:bg-muted/50"}`}>
                        <td className="py-1 pr-3 font-mono">{r.code}</td><td className="pr-3">{r.name}</td>
                        <td className="pr-3 text-muted-foreground">{r.instagram ? `@${r.instagram}` : "—"}</td><td className="tabular-nums">{jstDay(r.joined_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {focused && (
              <div className="rounded-lg bg-[#8cabd9]/30 p-3">
                <p className="text-[11px] text-muted-foreground mb-1.5">{focused.name} ({focused.code}) 님이 받는 LINE</p>
                <p className="rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap shadow-sm">{focused.text}</p>
              </div>
            )}
          </div>
        )}
        {preview && preview.length === 0 && <p className="text-xs text-muted-foreground">지금 조건에 맞는 사람이 없습니다.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy || tooLong || (def.param === "period" && !period)} onClick={runPreview} className="h-8 rounded border text-xs px-4 disabled:opacity-50">{busy && !preview ? "찾는 중…" : preview ? "미리 보기 다시" : "미리 보기"}</button>
          <button type="button" disabled={busy || !preview || preview.length === 0 || tooLong} onClick={send} className="h-8 rounded bg-foreground text-background text-xs px-4 disabled:opacity-50">
            {preview ? `${preview.length}명에게 보내기` : "미리 보기 후 보내기"}
          </button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </section>
    </div>
  );
}

// ── 상황별 설정 ───────────────────────────────────────────────────────────────

function KindSettings({ secret, data, onEdit, onDone }: { secret: string; data: MessageKindsData; onEdit: (kind: string) => void; onDone: () => void }) {
  const reset = async (k: MessageKindView) => {
    if (!window.confirm(`「${k.label}」 저장 문구를 지우고 기본 문구로 되돌립니다.`)) return;
    try { await postAdmin(secret, { action: "reset_message_template", kind: k.kind }); onDone(); }
    catch (e) { alert(e instanceof Error ? e.message : "실패"); }
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground text-left text-[11px]">
          <tr><th className="py-1.5 pr-3 font-normal">상황</th><th className="pr-3 font-normal">받는 사람</th><th className="pr-3 font-normal">다시 보내기</th><th className="pr-3 font-normal">문구</th><th className="pr-3 font-normal">마지막 발송</th><th className="pr-3 font-normal">발송 방식</th><th /></tr>
        </thead>
        <tbody>
          {data.kinds.map((k) => (
            <tr key={k.kind} className="border-t align-top">
              <td className="py-2 pr-3"><span className="text-muted-foreground">{k.group} · </span><span className="font-medium">{k.label}</span></td>
              <td className="pr-3 py-2 text-muted-foreground">{k.audience}</td>
              <td className="pr-3 py-2">{gapText(k.gap)}</td>
              <td className="pr-3 py-2">
                {k.customized
                  ? <><Pill className="bg-sky-50 text-sky-700">저장한 문구</Pill> <span className="text-muted-foreground">{k.savedAt ? jstDay(k.savedAt) : ""}</span> <button className="underline text-muted-foreground" onClick={() => reset(k)}>기본으로</button></>
                  : <span className="text-muted-foreground">기본 문구</span>}
              </td>
              <td className="pr-3 py-2 tabular-nums">{k.lastSentAt ? `${jstDay(k.lastSentAt)} · ${k.lastCount}명` : "—"}</td>
              <td className="pr-3 py-2">수동 <span className="text-muted-foreground">(자동은 준비 중)</span></td>
              <td className="py-2"><button className="underline whitespace-nowrap" onClick={() => onEdit(k.kind)}>보내기·문구 고치기</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 발송 내역 ─────────────────────────────────────────────────────────────────

function History({ secret, messages, data, codeById, clickDays, onDone }: {
  secret: string; messages: PartnerMessage[]; data: MessageKindsData; codeById: Map<number, string>; clickDays: number; onDone: () => void;
}) {
  const labelOf = (k?: string) => data.kinds.find((d) => d.kind === (k ?? "custom"))?.label ?? k ?? "메시지";
  const cancel = async (m: PartnerMessage) => {
    if (!window.confirm(`「${m.memo || labelOf(m.kind)}」 발송을 취소합니다.`)) return;
    try { await postAdmin(secret, { action: "cancel_message", messageId: m.id }); onDone(); }
    catch (e) { alert(e instanceof Error ? e.message : "실패"); }
  };
  if (messages.length === 0) return <p className="text-xs text-muted-foreground">아직 보낸 메시지가 없습니다.</p>;
  return (
    <ul className="space-y-2 text-xs">
      {messages.map((m) => (
        <li key={m.id} className="rounded border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{labelOf(m.kind)}</span>
            <span className="text-muted-foreground">{jstDay(m.created_at)} · 대상 {m.partner_ids.length}명{paramsText(m, clickDays) && ` · ${paramsText(m, clickDays)}`}</span>
            {m.notify_status === "sent" && <Pill className="bg-emerald-50 text-emerald-700">{`LINE 보냄 ${m.sent_count}명${m.failed_count > 0 ? ` · 실패 ${m.failed_count}` : ""}`}</Pill>}
            {m.notify_status === "pending" && <Pill className="bg-amber-50 text-amber-700">LINE 보류 — 09:05</Pill>}
            {m.notify_status === "failed" && <Pill className="bg-red-50 text-red-700">발송 실패</Pill>}
            {m.notify_status === "pending" && <button className="underline text-red-600" onClick={() => cancel(m)}>취소</button>}
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-muted-foreground">문구 · 받은 사람</summary>
            <p className="text-muted-foreground mt-1 whitespace-pre-wrap">{m.body}</p>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground break-all">{m.partner_ids.map((id) => codeById.get(Number(id)) ?? `#${id}`).join(" ")}</p>
          </details>
        </li>
      ))}
    </ul>
  );
}

// ── 카드 ──────────────────────────────────────────────────────────────────────

type SubTab = "compose" | "settings" | "history";

export default function AffiliateMessages({ secret, messages, kinds, rules, partners, onDone }: {
  secret: string;
  messages: PartnerMessage[];
  kinds: MessageKindsData | undefined;
  rules: { clickWindowDays: number; maxLength: number };
  partners: Array<{ id: number; code: string }>;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<SubTab>("compose");
  const [kind, setKind] = useState("first_share");
  const [notice, setNotice] = useState<string | null>(null);
  const codeById = useMemo(() => new Map(partners.map((p) => [p.id, p.code])), [partners]);

  const tabs: Array<[SubTab, string]> = [["compose", "보내기"], ["settings", "상황별 설정"], ["history", `발송 내역${messages.length ? ` ${messages.length}` : ""}`]];
  return (
    <Card>
      <CardHeader className="pb-3 space-y-0">
        <CardTitle className="text-sm">파트너 메시지</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          상황별로 받는 사람과 문구가 정해진 LINE. 미리 보기로 명단과 사람별 문구를 확인해야 보낼 수 있고, 누를 때만 나간다. LINE 친구를 끊은 사람은 LINE 이 건너뛴다.
        </p>
        <div className="flex gap-1 border-b pt-3">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium ${tab === k ? "border-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{label}</button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {notice && <p className="rounded bg-muted px-3 py-2 text-xs">{notice}</p>}
        {!kinds ? (
          <p className="text-xs text-muted-foreground">상황 목록을 불러오지 못했습니다.</p>
        ) : tab === "compose" ? (
          <Composer secret={secret} data={kinds} rules={rules} initialKind={kind}
            onSent={(m) => { setNotice(m); setTab("history"); onDone(); }} onTemplateSaved={onDone} />
        ) : tab === "settings" ? (
          <KindSettings secret={secret} data={kinds} onEdit={(k) => { setKind(k); setTab("compose"); }} onDone={onDone} />
        ) : (
          <History secret={secret} messages={messages} data={kinds} codeById={codeById} clickDays={rules.clickWindowDays} onDone={onDone} />
        )}
      </CardContent>
    </Card>
  );
}
