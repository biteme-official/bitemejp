/**
 * 어드민 「오픈 알림」 탭 (#248) — 출시 예정 상품마다 누가 기다리고, 알림이 나갔는지.
 *
 * 데이터는 /api/line-launch?view=admin 한 번. 신청(`line_launch_sub`)과 발송(`line_send`)을
 * 서버가 맞춰서 상품별 대기 인원·판매 여부를 붙여 준다.
 *
 * 발송은 자동이 아니다(재입고 알림 #227 과 같음). 판매를 시작한 상품을 골라 「보내기」를 누르면
 * 먼저 미리보기(몇 명·어떤 문안)를 받고, 확인을 한 번 더 눌러야 실제로 보낸다.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

type Status = "waiting" | "ready" | "sent" | "not_friend" | "gone";

interface Row {
  ref: string;
  createdAt: string;
  displayName: string | null;
  userTail: string;
  productId: string;
  productTitle: string;
  status: Status;
  sentAt: string | null;
}

interface Product {
  productId: string;
  title: string;
  titleKo: string | null;
  state: "before" | "open" | "gone";
  tagged: boolean;
  launchDate: string | null;
  waiting: number;
  sent: number;
  notFriend: number;
}

interface LaunchAdminData {
  products: Product[];
  rows: Row[];
  enabled: boolean;
  quietHours?: boolean;
  maxPerSend?: number;
  ttlDays: number;
}

/** POST ?action=send 응답 — dryRun 이면 미리보기, 아니면 결과 */
interface SendResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  quietHours: boolean;
  selected: number;
  notOpen: number;
  ready: number;
  willSend: number;
  sent: number;
  notFriend: number;
  failed: number;
  samples: string[];
}

const STATUS: Record<Status, { label: string; className: string }> = {
  waiting: { label: "판매 전", className: "bg-muted text-muted-foreground" },
  ready: { label: "판매 시작 · 보내기 전", className: "bg-amber-100 text-amber-800" },
  sent: { label: "발송 완료", className: "bg-emerald-100 text-emerald-800" },
  not_friend: { label: "친구 아님 · 미도달", className: "bg-red-100 text-red-700" },
  gone: { label: "상품 삭제됨", className: "bg-muted text-muted-foreground line-through" },
};

async function fetchLaunch(secret: string): Promise<LaunchAdminData> {
  const res = await fetch("/api/line-launch?view=admin", { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

async function postSend(secret: string, productIds: string[], dryRun: boolean): Promise<SendResult> {
  const res = await fetch("/api/line-launch?action=send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ productIds, dryRun }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<SendResult>;
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `${res.status}`);
  return json as SendResult;
}

/** JST 기준 「10/08 14:30」 */
function jst(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const productLink = (gid: string) => `/product/${gid.split("/").pop()}`;

function stateBadge(p: Product) {
  if (p.state === "gone") return <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] line-through">삭제됨</span>;
  if (p.state === "open") return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">판매 중</span>;
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      판매 전{!p.tagged && " · 태그 없음"}
    </span>
  );
}

export default function LaunchTab({ secret }: { secret: string }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["launch-admin", secret],
    queryFn: () => fetchLaunch(secret),
    enabled: !!secret,
    staleTime: 60_000,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SendResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const products = useMemo(() => data?.products ?? [], [data]);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  // 고를 수 있는 건 판매를 시작했고 기다리는 사람이 있는 상품뿐
  const sendable = useMemo(() => products.filter((p) => p.state === "open" && p.waiting > 0), [products]);
  const picked = useMemo(() => sendable.filter((p) => selected.has(p.productId)).map((p) => p.productId), [sendable, selected]);
  const sends = useMemo(
    () => rows.filter((r) => r.sentAt).sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? "")),
    [rows],
  );
  const totals = useMemo(
    () => ({
      upcoming: products.filter((p) => p.state === "before").length,
      waiting: rows.filter((r) => r.status === "waiting").length,
      ready: rows.filter((r) => r.status === "ready").length,
      sent: rows.filter((r) => r.status === "sent").length,
    }),
    [products, rows],
  );

  const toggle = (id: string, on: boolean) => {
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const askPreview = async () => {
    setBusy("preview");
    setSendMsg(null);
    try {
      setPreview(await postSend(secret, picked, true));
    } catch (e) {
      setSendMsg({ ok: false, text: `미리보기 실패: ${e instanceof Error ? e.message : ""}` });
    } finally {
      setBusy(null);
    }
  };
  const confirmSend = async () => {
    setBusy("send");
    try {
      const r = await postSend(secret, picked, false);
      setSendMsg({
        ok: r.failed === 0,
        text:
          `${r.sent}명에게 보냈습니다` +
          (r.notFriend ? ` · 친구 아님 ${r.notFriend}명(미도달)` : "") +
          (r.failed ? ` · 실패 ${r.failed}명 — 다시 골라 보내 주세요` : "") +
          (r.notOpen ? ` · 판매 전이라 뺀 상품 ${r.notOpen}개` : ""),
      });
      setSelected(new Set());
      setPreview(null);
      refetch();
    } catch (e) {
      setSendMsg({ ok: false, text: `발송 실패: ${e instanceof Error ? e.message : ""}` });
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <p className="text-xs text-muted-foreground py-8 text-center">불러오는 중…</p>;
  if (error || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        오픈 알림 목록을 불러오지 못했습니다.
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
        <span className="font-semibold">{data.enabled ? "● 수동 발송" : "○ 발송 꺼짐 — LINE_RESTOCK_ENABLED 미설정 (미리보기만)"}</span>
        <span>자동으로 나가지 않습니다 — 판매를 시작하면 「판매 중」으로 바뀌고, 아래에서 골라 보내야 LINE 이 나갑니다</span>
        <button
          onClick={() => refetch()}
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> 새로고침
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "출시 예정 상품", value: totals.upcoming, unit: "개" },
          { label: "판매 전 · 대기", value: totals.waiting, unit: "명" },
          { label: "판매 시작 · 보내기 전", value: totals.ready, unit: "명" },
          { label: "발송 완료", value: totals.sent, unit: "명" },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-bold tabular-nums">{c.value}<span className="text-xs font-normal ml-0.5">{c.unit}</span></p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row flex-wrap items-center gap-2 space-y-0">
          <CardTitle className="text-sm mr-auto">출시 예정 상품</CardTitle>
          <Button size="sm" disabled={picked.length === 0 || busy !== null} onClick={askPreview}>
            <Send className="h-3.5 w-3.5 mr-1" />
            {busy === "preview" ? "확인 중…" : `선택 ${picked.length}개 상품 알림 보내기`}
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="mb-2 text-[11px] text-muted-foreground">
            Shopify 상품 태그 「発売予定」(발매일 미정 → 近日発売) · 「発売予定:2026-11-01」(→ 11月1日発売予定)을 단 상품 + 신청이 있었던 상품 ·
            재고를 넣어 판매를 시작하면 「판매 중」이 되고 체크할 수 있습니다(태그는 떼지 않아도 됩니다)
          </p>
          {preview && (
            <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
              {preview.willSend === 0 ? (
                <p className="font-semibold">보낼 사람이 없습니다.{preview.notOpen > 0 && ` 판매 전·삭제된 상품 ${preview.notOpen}개`}</p>
              ) : (
                <>
                  <p className="font-semibold">
                    {preview.willSend}명에게 LINE 을 보냅니다 (신청 {preview.ready}건{preview.ready > preview.willSend && " — 한 사람의 여러 상품은 한 통으로 묶음"})
                  </p>
                  {preview.notOpen > 0 && <p>제외: 그새 판매 전으로 돌아간 상품 {preview.notOpen}개</p>}
                  {preview.quietHours && <p className="text-red-700 font-semibold">지금은 일본 시간 21~09시입니다 — 고객에게 밤·새벽에 도착합니다.</p>}
                  {!data.enabled && <p className="text-red-700 font-semibold">LINE_RESTOCK_ENABLED 가 꺼져 있어 보낼 수 없습니다.</p>}
                  {preview.samples[0] && (
                    <pre className="whitespace-pre-wrap rounded border bg-white p-2 text-[11px] text-foreground font-sans">{preview.samples[0]}</pre>
                  )}
                </>
              )}
              <div className="flex gap-2">
                {preview.willSend > 0 && (
                  <Button size="sm" disabled={busy !== null || !data.enabled} onClick={confirmSend}>
                    {busy === "send" ? "보내는 중…" : `${preview.willSend}명에게 보내기`}
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={busy === "send"} onClick={() => setPreview(null)}>
                  취소
                </Button>
              </div>
            </div>
          )}
          {sendMsg && (
            <p className={cn("mb-3 rounded px-3 py-2 text-xs", sendMsg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>
              {sendMsg.text}
            </p>
          )}
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th:not(.text-right)]:text-left">
                <th className="w-6" />
                <th>상품명 (일본어 · 한글)</th><th>발매일</th><th>상태</th>
                <th className="text-right">대기</th><th className="text-right">발송</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">출시 예정 상품이 없습니다. Shopify 상품에 「発売予定」 태그를 달아 주세요.</td></tr>
              )}
              {products.map((p) => {
                const canPick = p.state === "open" && p.waiting > 0;
                return (
                  <tr key={p.productId} className={cn("border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top", canPick && "bg-amber-50/50")}>
                    <td>
                      {canPick && (
                        <Checkbox
                          aria-label="이 상품 선택"
                          disabled={busy === "send"}
                          checked={selected.has(p.productId)}
                          onCheckedChange={(v) => toggle(p.productId, v === true)}
                        />
                      )}
                    </td>
                    <td className="min-w-[220px]">
                      <a href={productLink(p.productId)} target="_blank" rel="noopener noreferrer" className="hover:underline">{p.title}</a>
                      {p.titleKo && <p className="text-muted-foreground">{p.titleKo}</p>}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{p.launchDate ?? (p.tagged ? "미정" : "—")}</td>
                    <td className="whitespace-nowrap">{stateBadge(p)}</td>
                    <td className="text-right tabular-nums">{p.waiting > 0 ? <span className="font-semibold">{p.waiting}명</span> : <span className="text-muted-foreground">0</span>}</td>
                    <td className="text-right tabular-nums text-muted-foreground">
                      {p.sent}명{p.notFriend > 0 && <span className="text-red-600"> (+미도달 {p.notFriend})</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">신청 목록 <span className="font-normal text-muted-foreground">({rows.length}건)</span></CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th]:text-left">
                <th>신청 (JST)</th><th>고객</th><th>상품</th><th>상태</th><th>발송 (JST)</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">신청이 없습니다.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.ref + r.userTail} className="border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top">
                  <td className="whitespace-nowrap tabular-nums">{jst(r.createdAt)}</td>
                  <td>
                    {r.displayName ?? <span className="text-muted-foreground">(이름 모름)</span>}
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">…{r.userTail}</span>
                  </td>
                  <td>
                    <a href={productLink(r.productId)} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {r.productTitle || "(상품명 없음)"}
                    </a>
                  </td>
                  <td><span className={cn("rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap", STATUS[r.status].className)}>{STATUS[r.status].label}</span></td>
                  <td className="whitespace-nowrap tabular-nums text-muted-foreground">{jst(r.sentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        최근 {data.ttlDays}일 신청 기준 · 같은 사람이 같은 상품을 여러 번 누르면 한 건 · 고객 이름은 LINE 공식계정 친구일 때만 보입니다 ·{" "}
        보낼 때 판매 여부를 다시 확인합니다 · 한 번에 최대 {data.maxPerSend ?? 200}명 · 발송 {sends.length}건
      </p>
    </div>
  );
}
