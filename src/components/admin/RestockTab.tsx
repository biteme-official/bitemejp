/**
 * 어드민 「재입고 알림」 탭 (#221) — 누가 무엇을 신청했고, 알림이 나갔는지.
 *
 * 데이터는 /api/line-restock?view=admin 한 번. 신청(`line_restock_sub`)과 발송(`line_send`)을
 * 서버가 맞춰서, 아직 안 보낸 신청은 지금 재고까지 확인해 상태를 붙여 준다.
 *
 * 발송은 자동이 아니다 (#227). 재고가 풀린 신청(「재입고됨」)을 이 화면에서 골라 「선택 발송」을 눌러야 나간다.
 * 누르면 먼저 미리보기(몇 명·어떤 문안)를 받고, 확인을 한 번 더 눌러야 실제로 보낸다.
 *
 * 상품별 발송 (#252) — 신청을 상품으로 묶어 「이 상품만 보내기」로 한 상품만 고른다.
 * 신청 목록의 「전체 선택」은 보이는 줄에만 걸리므로, 상품 필터로 거르면 그 상품만 선택된다.
 *
 * 목록은 10개씩 페이지로 나눈다 (#254). 「전체 선택」은 지금 페이지가 아니라 걸러진 목록 전체(모든 페이지)에 걸린다.
 *
 * 순서 (#256): 상품별 재입고 알림 목록(재입고됨·품절 중을 버튼으로 거름) → 신청 목록 → 발송 이력 → 발송 목록 → 지금 품절 목록
 *
 * 발송 결과·이력 (#322) — 결과는 맨 위 띠에 닫을 때까지 남기고, 「보내기」 한 번마다 발송 이력에 한 줄.
 * 방금 보낸 신청은 목록을 다시 받기 전에도 「발송 완료」로 바꿔 다시 고를 수 없게 한다.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import ListPager from "@/components/admin/ListPager";
import { usePaged } from "@/hooks/usePaged";

type Status = "waiting" | "ready" | "sent" | "not_friend" | "gone" | "discontinued";

interface Row {
  /** 신청 키 — 골라 보낼 때 서버에 돌려준다 */
  ref: string;
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

interface SoldOutProduct {
  productId: string;
  title: string;
  titleKo: string | null;
  titleKoSource: "shopify" | "ai" | null;
  variantCount: number;
  soldOut: { id: string; title: string; discontinued: boolean }[];
}

/** 「보내기」 한 번 = 한 줄 (#322) */
interface Batch {
  batchId: string;
  startedAt: string;
  finishedAt: string | null;
  state: "done" | "sending" | "aborted";
  willSend: number;
  products: { productId: string; title: string; n: number }[];
  sent: number | null;
  notFriend: number | null;
  failed: number | null;
  skipped: { notAvailable: number; notPending: number; missing: number };
  /** 실패 이유별 인원 (#324) */
  failReasons?: Record<string, number>;
}

interface RestockAdminData {
  rows: Row[];
  batches?: Batch[];
  /** 지금 품절 옵션이 있는 판매 중 상품 (#225) */
  soldOut?: SoldOutProduct[];
  soldOutError?: string | null;
  /** 신청 상품의 한글명 (#258) — 메타필드 custom.name_ko, 없으면 AI 번역 */
  namesKo?: Record<string, { ko: string; source: "shopify" | "ai" }>;
  enabled: boolean;
  /** 지금 JST 21~09시인가 — 막지는 않고 경고만 */
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
  notPending: number;
  missing: number;
  notAvailable: number;
  ready: number;
  willSend: number;
  sent: number;
  notFriend: number;
  failed: number;
  samples: string[];
  /** 실제 처리된(보냄·친구 아님) 신청 — 이것만 화면에서 「발송 완료」로 */
  doneRefs?: string[];
  /** 실패한 사람과 이유 (#324) */
  failures?: { userTail: string; products: string; reason: string }[];
}

/** 발송 결과 알림창 (#324) */
interface ResultDialog {
  ok: boolean;
  title: string;
  lines: string[];
  failures: { userTail: string; products: string; reason: string }[];
}

const STATUS: Record<Status, { label: string; className: string }> = {
  waiting: { label: "품절 중", className: "bg-muted text-muted-foreground" },
  ready: { label: "재입고됨 · 보내기 전", className: "bg-amber-100 text-amber-800" },
  sent: { label: "발송 완료", className: "bg-emerald-100 text-emerald-800" },
  not_friend: { label: "친구 아님 · 미도달", className: "bg-red-100 text-red-700" },
  gone: { label: "옵션 삭제됨", className: "bg-muted text-muted-foreground line-through" },
  discontinued: { label: "판매 종료", className: "bg-muted text-muted-foreground line-through" },
};

async function fetchSoldOut(secret: string): Promise<{ soldOut: SoldOutProduct[]; soldOutError: string | null }> {
  const res = await fetch("/api/line-restock?view=soldout", { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function fetchRestock(secret: string): Promise<RestockAdminData> {
  const res = await fetch("/api/line-restock?view=admin", { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

async function postSend(secret: string, refs: string[], dryRun: boolean): Promise<SendResult> {
  const res = await fetch("/api/line-restock?action=send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ refs, dryRun }),
  });
  const raw = await res.text();
  let json: Partial<SendResult> = {};
  try {
    json = JSON.parse(raw) as Partial<SendResult>;
  } catch {
    // JSON 이 아니면 Vercel 이 대신 답한 것 — 시간 초과·서버 오류
  }
  if (!res.ok || json.ok === false) throw new Error(json.error ?? httpReason(res.status));
  return json as SendResult;
}

/** 서버가 이유를 못 준 실패 — 상태 코드로 설명 */
function httpReason(status: number): string {
  if (status === 504) return "서버 응답 시간 초과(504) — 보내는 도중 끊겼을 수 있습니다";
  if (status === 401) return "어드민 인증이 풀렸습니다(401) — 다시 로그인해 주세요";
  if (status >= 500) return `서버 오류(${status})`;
  return `요청 실패(${status})`;
}

/** 고른 것 중 보내지 않는 것들 — 「3건은 그새 다시 품절」 */
function skippedNote(r: SendResult): string {
  const parts = [
    r.notAvailable > 0 && `다시 품절 ${r.notAvailable}건`,
    r.notPending > 0 && `이미 발송·목록에 없음 ${r.notPending}건`,
    r.missing > 0 && `옵션 삭제 ${r.missing}건`,
  ].filter(Boolean);
  return parts.length ? `제외: ${parts.join(" · ")}` : "";
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
    // 창을 오갈 때마다 다시 받지 않는다 — 목록 한 번이 무겁다 (#328). 새로고침 버튼·발송 뒤에만
    refetchOnWindowFocus: false,
  });
  // 「지금 품절 목록」은 쇼핑몰 옵션 전부를 훑어 오래 걸린다 — 따로 받아 탭이 먼저 뜨게 (#328)
  const soldOutQuery = useQuery({
    queryKey: ["restock-soldout", secret],
    queryFn: () => fetchSoldOut(secret),
    enabled: !!secret,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const [filter, setFilter] = useState<Status | "all">("all");
  const [productFilter, setProductFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<"all" | "ready" | "waiting">("all");
  const listRef = useRef<HTMLDivElement>(null);
  const [soldKind, setSoldKind] = useState<"temp" | "ended">("temp");
  const [soldQuery, setSoldQuery] = useState("");
  // 수동 발송 (#227) — 고른 신청 → 미리보기(preview) → 확정
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SendResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string; at?: string } | null>(null);
  /**
   * 방금 보낸 신청 (#322). 목록을 다시 받기 전·다시 받는 데 실패해도 「재입고됨」으로 되돌아가
   * 또 고를 수 있게 되지 않도록, 화면에서 먼저 「발송 완료」로 바꿔 둔다.
   */
  const [justSent, setJustSent] = useState<Map<string, string>>(new Map());
  const [dialog, setDialog] = useState<ResultDialog | null>(null);
  const msgRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      (data?.rows ?? []).map((r) =>
        r.status === "ready" && justSent.has(r.ref) ? { ...r, status: "sent" as const, sentAt: justSent.get(r.ref)! } : r,
      ),
    [data, justSent],
  );
  const counts = useMemo(() => {
    const c: Record<Status, number> = { waiting: 0, ready: 0, sent: 0, not_friend: 0, gone: 0, discontinued: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);


  const sends = useMemo(
    () => rows.filter((r) => r.sentAt).sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? "")),
    [rows],
  );
  const shown = rows.filter(
    (r) => (filter === "all" || r.status === filter) && (productFilter === "all" || r.productId === productFilter),
  );

  // 신청 목록 상품 필터 — 신청이 있는 상품만, 신청 많은 순
  const productOptions = useMemo(() => {
    const m = new Map<string, { title: string; n: number }>();
    for (const r of rows) {
      const cur = m.get(r.productId) ?? { title: r.productTitle || "(상품명 없음)", n: 0 };
      cur.n++;
      m.set(r.productId, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n || a[1].title.localeCompare(b[1].title));
  }, [rows]);

  // 상품별 재입고 알림 목록 (#256) — 아직 안 보낸 신청(재입고됨 + 품절 중)을 상품으로 묶는다.
  // 재입고된 신청이 하나라도 있으면 「재입고됨」, 전부 품절이면 「품절 중」
  const productGroups = useMemo(() => {
    const m = new Map<
      string,
      { productId: string; title: string; refs: string[]; waiting: number; variants: Map<string, { n: number; ready: boolean }> }
    >();
    for (const r of rows) {
      if (r.status !== "ready" && r.status !== "waiting") continue;
      const cur = m.get(r.productId) ?? { productId: r.productId, title: r.productTitle || "(상품명 없음)", refs: [], waiting: 0, variants: new Map() };
      if (r.status === "ready") cur.refs.push(r.ref);
      else cur.waiting++;
      const key = r.variantTitle || "";
      const v = cur.variants.get(key) ?? { n: 0, ready: r.status === "ready" };
      v.n++;
      cur.variants.set(key, v);
      m.set(r.productId, cur);
    }
    return [...m.values()].sort(
      (a, b) => b.refs.length - a.refs.length || b.waiting - a.waiting || a.title.localeCompare(b.title),
    );
  }, [rows]);
  const groupCounts = useMemo(
    () => ({
      all: productGroups.length,
      ready: productGroups.filter((g) => g.refs.length > 0).length,
      waiting: productGroups.filter((g) => g.refs.length === 0).length,
    }),
    [productGroups],
  );
  const groupShown = useMemo(
    () =>
      groupFilter === "all"
        ? productGroups
        : productGroups.filter((g) => (groupFilter === "ready" ? g.refs.length > 0 : g.refs.length === 0)),
    [productGroups, groupFilter],
  );

  // 고를 수 있는 건 「재입고됨」뿐. 목록이 새로 오면 더는 보낼 수 없게 된 선택은 지운다
  const readyRefs = useMemo(() => rows.filter((r) => r.status === "ready").map((r) => r.ref), [rows]);
  const picked = useMemo(() => readyRefs.filter((ref) => selected.has(ref)), [readyRefs, selected]);
  // 미리보기에 「어느 상품이 몇 건」 — 의도하지 않은 상품이 섞였는지 바로 보이게
  const pickedByProduct = useMemo(() => {
    const m = new Map<string, { title: string; n: number }>();
    for (const r of rows) {
      if (r.status !== "ready" || !selected.has(r.ref)) continue;
      const cur = m.get(r.productId) ?? { title: r.productTitle || "(상품명 없음)", n: 0 };
      cur.n++;
      m.set(r.productId, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [rows, selected]);
  const shownReady = shown.filter((r) => r.status === "ready");
  const allShownPicked = shownReady.length > 0 && shownReady.every((r) => selected.has(r.ref));

  const toggle = (ref: string, on: boolean) => {
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(ref);
      else next.delete(ref);
      return next;
    });
  };
  const toggleShown = (on: boolean) => {
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of shownReady) {
        if (on) next.add(r.ref);
        else next.delete(r.ref);
      }
      return next;
    });
  };

  const askPreview = async (refs: string[] = picked) => {
    setBusy("preview");
    setSendMsg(null);
    try {
      setPreview(await postSend(secret, refs, true));
    } catch (e) {
      const reason = e instanceof Error ? e.message : "알 수 없는 오류";
      setSendMsg({ ok: false, text: `미리보기 실패: ${reason}` });
      setDialog({ ok: false, title: "미리보기 실패", lines: [reason, "아직 아무에게도 보내지 않았습니다."], failures: [] });
    } finally {
      setBusy(null);
    }
  };
  /** 한 상품만 — 그 상품의 「재입고됨」 신청만 고르고, 목록도 그 상품으로 거른 뒤 미리보기 */
  const pickProduct = (productId: string, refs: string[]) => {
    setPreview(null);
    setSelected(new Set(refs));
    setFilter("ready");
    setProductFilter(productId);
    // 미리보기는 아래 신청 목록에 뜬다 — 위에서 누르면 안 보이므로 내려 준다
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    askPreview(refs);
  };

  const confirmSend = async () => {
    setBusy("send");
    const refs = picked;
    const at = new Date().toISOString();
    try {
      const r = await postSend(secret, refs, false);
      const note = skippedNote(r);
      const text =
        `${r.sent}명에게 보냈습니다` +
        (r.notFriend ? ` · 친구 아님 ${r.notFriend}명(미도달)` : "") +
        (r.failed ? ` · 실패 ${r.failed}명 — 「재입고됨」에 남아 있으니 다시 골라 보내 주세요` : "") +
        (note ? ` · ${note}` : "");
      setSendMsg({ ok: r.failed === 0, at, text });
      // 서버가 처리했다고 돌려준 신청만 먼저 「발송 완료」로 — 실패한 사람은 다시 고를 수 있게 남긴다
      const done = r.doneRefs ?? (r.failed === 0 ? refs : []);
      setJustSent((prev) => new Map([...prev, ...done.map((ref) => [ref, at] as const)]));
      if (r.willSend === 0) {
        setDialog({ ok: false, title: "보낸 사람이 없습니다", lines: [note || "보낼 수 있는 신청이 없었습니다."], failures: [] });
      } else if (r.failed > 0) {
        setDialog({
          ok: false,
          title: r.sent > 0 ? `일부 실패 — ${r.failed}명에게 못 보냈습니다` : `발송 실패 — ${r.failed}명`,
          lines: [text],
          failures: r.failures ?? [],
        });
      } else {
        setDialog({ ok: true, title: "발송 완료", lines: [text], failures: [] });
      }
      setSelected(new Set());
      setPreview(null);
    } catch (e) {
      // 응답을 못 받았다고 안 나간 게 아니다(도중에 끊겼을 수 있다). 다시 누르기 전에 목록·이력을 보게 한다
      const reason = e instanceof Error ? e.message : "알 수 없는 오류";
      setSendMsg({ ok: false, at, text: `발송 실패: ${reason}` });
      setDialog({
        ok: false,
        title: "발송 실패",
        lines: [reason, "일부는 이미 나갔을 수 있습니다. 바로 다시 누르지 말고 「발송 이력」과 신청 상태를 확인해 주세요."],
        failures: [],
      });
      setSelected(new Set());
      setPreview(null);
    } finally {
      setBusy(null);
      refetch();
      msgRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // 지금 품절 목록 — 일시품절(알림 받음)과 판매 종료(숨김)로 나눠 본다. 대기 인원 많은 상품부터
  const soldOut = useMemo(() => {
    const waitingBy = new Map<string, number>();
    for (const r of rows) if (r.status === "waiting") waitingBy.set(r.variantId, (waitingBy.get(r.variantId) ?? 0) + 1);
    const pick = (ended: boolean) =>
      (soldOutQuery.data?.soldOut ?? [])
        .map((p) => {
          const variants = p.soldOut.filter((v) => v.discontinued === ended);
          const waiting = variants.reduce((n, v) => n + (waitingBy.get(v.id) ?? 0), 0);
          return { ...p, variants, waiting, all: p.soldOut.length === p.variantCount };
        })
        .filter((p) => p.variants.length > 0)
        .sort((a, b) => b.waiting - a.waiting || Number(b.all) - Number(a.all) || a.title.localeCompare(b.title));
    return { temp: pick(false), ended: pick(true) };
  }, [soldOutQuery.data, rows]);
  const soldShown = useMemo(() => {
    const q = soldQuery.trim().toLowerCase();
    const list = soldOut[soldKind];
    if (!q) return list;
    return list.filter((p) =>
      [p.title, p.titleKo ?? "", ...p.variants.map((v) => v.title)].some((t) => t.toLowerCase().includes(q)),
    );
  }, [soldOut, soldKind, soldQuery]);

  // 목록마다 10개씩 (#254) — 필터·검색이 바뀌면 1페이지로
  const soldPage = usePaged(soldShown, `${soldKind}|${soldQuery}`);
  const groupPage = usePaged(groupShown, groupFilter);
  const listPage = usePaged(shown, `${filter}|${productFilter}`);
  const sendPage = usePaged(sends);
  const batches = useMemo(() => data?.batches ?? [], [data]);
  const batchPage = usePaged(batches);

  if (isLoading) return <p className="text-xs text-muted-foreground py-8 text-center">불러오는 중…</p>;
  // 다시 받기만 실패했으면 화면을 통째로 바꾸지 않는다 — 방금 보낸 결과가 같이 사라진다
  if (!data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        재입고 알림 목록을 불러오지 못했습니다.
        <p className="text-xs mt-1 text-red-600">{error instanceof Error ? error.message : ""}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/*
        보내기 확인 (#326) — 예전엔 표 위 노란 칸에 떴는데 눈에 안 띄어서, 「보내기」를 눌러도
        「확인 중…」 뒤 아무 일도 없는 것처럼 보였다(실제로는 이 확인을 한 번 더 눌러야 나간다). 가운데 창으로.
      */}
      <AlertDialog open={preview !== null} onOpenChange={(o) => !o && busy !== "send" && setPreview(null)}>
        <AlertDialogContent>
          {preview && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className={preview.willSend === 0 ? "text-red-700" : undefined}>
                  {preview.willSend === 0 ? "⚠ 보낼 사람이 없습니다" : `${preview.willSend}명에게 재입고 알림을 보낼까요?`}
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2 text-sm text-foreground">
                    {preview.willSend === 0 ? (
                      <p>{skippedNote(preview) || "고른 신청 중 지금 보낼 수 있는 것이 없습니다."}</p>
                    ) : (
                      <>
                        <p>
                          신청 {preview.ready}건{preview.ready > preview.willSend && " — 한 사람의 여러 옵션은 한 통으로 묶음"}
                        </p>
                        {pickedByProduct.length > 0 && (
                          <p>
                            {pickedByProduct.length > 1 && <span className="font-semibold text-red-700">상품 {pickedByProduct.length}개가 섞여 있습니다 — </span>}
                            {pickedByProduct.map((p) => `${p.title} ${p.n}건`).join(" · ")}
                          </p>
                        )}
                        {skippedNote(preview) && <p className="text-muted-foreground">{skippedNote(preview)}</p>}
                        {preview.quietHours && <p className="text-red-700 font-semibold">지금은 일본 시간 21~09시입니다 — 고객에게 밤·새벽에 도착합니다.</p>}
                        {!data.enabled && <p className="text-red-700 font-semibold">LINE_RESTOCK_ENABLED 가 꺼져 있어 보낼 수 없습니다.</p>}
                        {preview.samples[0] && (
                          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-[11px] font-sans">{preview.samples[0]}</pre>
                        )}
                      </>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button variant="outline" disabled={busy === "send"} onClick={() => setPreview(null)}>
                  {preview.willSend === 0 ? "닫기" : "취소"}
                </Button>
                {preview.willSend > 0 && (
                  <Button disabled={busy !== null || !data.enabled} onClick={confirmSend}>
                    <Send className="h-3.5 w-3.5 mr-1" />
                    {busy === "send" ? "보내는 중…" : `${preview.willSend}명에게 보내기`}
                  </Button>
                )}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className={dialog?.ok ? "text-emerald-700" : "text-red-700"}>
              {dialog?.ok ? "✓ " : "⚠ "}
              {dialog?.title}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-foreground">
                {dialog?.lines.map((l, i) => <p key={i}>{l}</p>)}
                {dialog && dialog.failures.length > 0 && (
                  <div className="max-h-60 overflow-y-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted text-muted-foreground">
                        <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left [&>th]:font-medium">
                          <th>고객</th><th>상품</th><th>실패 사유</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dialog.failures.map((f, i) => (
                          <tr key={i} className="border-t [&>td]:px-2 [&>td]:py-1 [&>td]:align-top">
                            <td className="font-mono whitespace-nowrap">…{f.userTail}</td>
                            <td>{f.products || "—"}</td>
                            <td className="text-red-700">{f.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setDialog(null)}>확인</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div
        className={cn(
          "rounded-lg border px-4 py-2.5 text-xs flex flex-wrap items-center gap-x-4 gap-y-1",
          data.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800",
        )}
      >
        <span className="font-semibold">{data.enabled ? "● 수동 발송" : "○ 발송 꺼짐 — LINE_RESTOCK_ENABLED 미설정 (미리보기만)"}</span>
        <span>자동으로 나가지 않습니다 — 재고를 넣으면 「재입고됨」으로 바뀌고, 상품별 목록이나 신청 목록에서 골라 보내야 LINE 이 나갑니다</span>
        <button
          onClick={() => refetch()}
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> 새로고침
        </button>
      </div>

      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          목록을 새로 받지 못해 이전 내용을 보여 주고 있습니다 — {error instanceof Error ? error.message : ""}
        </p>
      )}

      {/* 발송 결과 — 누른 버튼 근처가 아니라 맨 위에, 닫을 때까지 남긴다 (#322) */}
      <div ref={msgRef} className="scroll-mt-4">
        {sendMsg && (
          <div
            className={cn(
              "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
              sendMsg.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-300 bg-red-50 text-red-800",
            )}
          >
            <p className="flex-1">
              <span className="font-semibold">{sendMsg.ok ? "✓ 발송 완료" : "확인 필요"}</span>
              {sendMsg.at && <span className="ml-2 text-xs opacity-70 tabular-nums">{jst(sendMsg.at)}</span>}
              <br />
              {sendMsg.text}
            </p>
            <button onClick={() => setSendMsg(null)} className="text-xs opacity-70 hover:opacity-100">닫기</button>
          </div>
        )}
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

      <Card className="border-amber-300">
        <CardHeader className="pb-2 flex flex-row flex-wrap items-center gap-2 space-y-0">
          <CardTitle className="text-sm mr-auto">
            상품별 재입고 알림 목록 <span className="font-normal text-muted-foreground">({productGroups.length}개 상품)</span>
          </CardTitle>
          {(["all", "ready", "waiting"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setGroupFilter(k)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs",
                groupFilter === k ? "bg-foreground text-background border-foreground" : "text-muted-foreground",
              )}
            >
              {k === "all" ? "전체" : k === "ready" ? "재입고됨" : "품절 중"} {groupCounts[k]}
            </button>
          ))}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="mb-2 text-[11px] text-muted-foreground">
            아직 알림을 보내지 않은 신청을 상품별로 묶었습니다 · 「이 상품만 보내기」를 누르면 그 상품의 재입고된 신청만 골라 확인 창을 띄웁니다 — 창에서 「N명에게 보내기」를 한 번 더 눌러야 나갑니다
          </p>
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th:not(.text-right)]:text-left">
                <th>상품</th><th>한글 상품명</th><th>옵션 · 신청 수</th><th className="text-right">재입고됨</th><th className="text-right">품절 중</th><th className="text-right" />
              </tr>
            </thead>
            <tbody>
              {groupShown.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">해당하는 상품이 없습니다.</td></tr>
              )}
              {groupPage.items.map((p) => {
                const on = p.refs.length > 0 && productFilter === p.productId && picked.length === p.refs.length && p.refs.every((ref) => selected.has(ref));
                return (
                  <tr key={p.productId} className={cn("border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top", on && "bg-amber-50")}>
                    <td className="min-w-[200px]">
                      <a href={productLink(p.productId)} target="_blank" rel="noopener noreferrer" className="hover:underline">{p.title}</a>
                    </td>
                    <td className="min-w-[160px]">
                      {data.namesKo?.[p.productId] ? (
                        <>
                          {data.namesKo[p.productId].ko}
                          {data.namesKo[p.productId].source === "ai" && <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">자동 번역</span>}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {[...p.variants].map(([v, { n, ready }]) => (
                          <span
                            key={v}
                            title={ready ? "재입고됨" : "품절 중"}
                            className={cn("rounded px-1.5 py-0.5 text-[11px]", ready ? "bg-amber-100 text-amber-800" : "bg-muted text-muted-foreground")}
                          >
                            {v || "단일 옵션"} {n}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{p.refs.length > 0 ? <span className="font-semibold">{p.refs.length}건</span> : <span className="text-muted-foreground">0</span>}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{p.waiting}건</td>
                    <td className="text-right">
                      {p.refs.length > 0 ? (
                        <Button size="sm" variant={on ? "default" : "outline"} disabled={busy !== null} onClick={() => pickProduct(p.productId, p.refs)}>
                          <Send className="h-3.5 w-3.5 mr-1" />
                          {busy === "preview" && on ? "확인 중…" : "이 상품만 보내기"}
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap">재고 입고 전</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ListPager p={groupPage} />
        </CardContent>
      </Card>

      <Card ref={listRef} className="scroll-mt-4">
        <CardHeader className="pb-2 flex flex-row flex-wrap items-center gap-2 space-y-0">
          <CardTitle className="text-sm mr-auto">
            신청 목록 <span className="font-normal text-muted-foreground">({shown.length}건{filter !== "all" && ` · ${STATUS[filter].label}`})</span>
          </CardTitle>
          <select
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
            aria-label="상품으로 거르기"
            className="h-7 max-w-[220px] rounded border bg-background px-2 text-xs"
          >
            <option value="all">상품 전체</option>
            {productOptions.map(([id, o]) => (
              <option key={id} value={id}>{o.title} ({o.n})</option>
            ))}
          </select>
          {readyRefs.length > 0 && filter !== "ready" && (
            <button onClick={() => setFilter("ready")} className="text-xs text-muted-foreground hover:text-foreground underline">
              재입고됨만 보기 ({readyRefs.length})
            </button>
          )}
          <Button size="sm" disabled={picked.length === 0 || busy !== null} onClick={() => askPreview()}>
            <Send className="h-3.5 w-3.5 mr-1" />
            {busy === "preview" ? "확인 중…" : `선택 ${picked.length}건 보내기`}
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th]:text-left">
                <th className="w-6">
                  <Checkbox
                    aria-label="걸러진 재입고됨 신청 전체 선택 (모든 페이지)"
                    title="걸러진 재입고됨 신청 전체 선택 (모든 페이지)"
                    disabled={shownReady.length === 0 || busy === "send"}
                    checked={allShownPicked}
                    onCheckedChange={(v) => toggleShown(v === true)}
                  />
                </th>
                <th>신청 (JST)</th><th>고객</th><th>상품 · 옵션</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">신청이 없습니다.</td></tr>
              )}
              {listPage.items.map((r) => (
                <tr key={`${r.userTail}|${r.variantId}|${r.createdAt}`} className="border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top">
                  <td>
                    {r.status === "ready" && (
                      <Checkbox
                        aria-label="이 신청 선택"
                        disabled={busy === "send"}
                        checked={selected.has(r.ref)}
                        onCheckedChange={(v) => toggle(r.ref, v === true)}
                      />
                    )}
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{jst(r.createdAt)}</td>
                  <td><Customer r={r} /></td>
                  <td><Product r={r} /></td>
                  <td><span className={cn("rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap", STATUS[r.status].className)}>{STATUS[r.status].label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager p={listPage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            발송 이력 <span className="font-normal text-muted-foreground">(보내기 {batches.length}회)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="mb-2 text-[11px] text-muted-foreground">
            「보내기」를 누를 때마다 한 줄 · 한 번 나간 신청은 「발송 완료」로 바뀌어 다시 고를 수 없습니다 · 보내는 중에는 다른 발송을 막습니다
          </p>
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th:not(.text-right)]:text-left">
                <th>보낸 시각 (JST)</th><th>상품</th><th className="text-right">대상</th><th className="text-right">보냄</th>
                <th className="text-right">친구 아님</th><th className="text-right">실패</th><th>제외</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 && (
                <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">아직 보낸 적이 없습니다.</td></tr>
              )}
              {batchPage.items.map((b) => {
                const skipped = [
                  b.skipped.notAvailable > 0 && `다시 품절 ${b.skipped.notAvailable}`,
                  b.skipped.notPending > 0 && `이미 발송 ${b.skipped.notPending}`,
                  b.skipped.missing > 0 && `옵션 삭제 ${b.skipped.missing}`,
                ].filter(Boolean).join(" · ");
                return (
                  <tr key={b.batchId} className="border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top">
                    <td className="whitespace-nowrap tabular-nums">{jst(b.startedAt)}</td>
                    <td className="min-w-[200px]">
                      {b.products.map((p) => (
                        <div key={p.productId}>
                          <a href={productLink(p.productId)} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {data.namesKo?.[p.productId]?.ko ?? (p.title || "(상품명 없음)")}
                          </a>
                          <span className="ml-1 text-muted-foreground">{p.n}건</span>
                        </div>
                      ))}
                    </td>
                    <td className="text-right tabular-nums">{b.willSend}명</td>
                    <td className="text-right tabular-nums font-semibold">{b.sent ?? "—"}</td>
                    <td className="text-right tabular-nums">{b.notFriend ?? "—"}</td>
                    <td className={cn("text-right tabular-nums", (b.failed ?? 0) > 0 && "font-semibold text-red-700")}>
                      {b.failed ?? "—"}
                      {Object.entries(b.failReasons ?? {}).map(([reason, n]) => (
                        <p key={reason} className="whitespace-nowrap text-[10px] font-normal">{reason} {n}</p>
                      ))}
                    </td>
                    <td className="text-muted-foreground">{skipped || "—"}</td>
                    <td>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap",
                          b.state === "done" ? "bg-emerald-100 text-emerald-800" : b.state === "sending" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700",
                        )}
                        title={b.state === "aborted" ? "끝 기록 없이 끊겼습니다 — 실제로 나간 사람은 아래 발송 목록이 맞습니다" : undefined}
                      >
                        {b.state === "done" ? "완료" : b.state === "sending" ? "보내는 중" : "중단됨"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ListPager p={batchPage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">발송 목록 · 사람별 <span className="font-normal text-muted-foreground">({sends.length}건)</span></CardTitle>
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
              {sendPage.items.map((r) => (
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
          <ListPager p={sendPage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row flex-wrap items-center gap-2 space-y-0">
          <CardTitle className="text-sm mr-auto">지금 품절 목록</CardTitle>
          {(["temp", "ended"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSoldKind(k)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs",
                soldKind === k ? "bg-foreground text-background border-foreground" : "text-muted-foreground",
              )}
            >
              {k === "temp" ? "일시품절" : "판매 종료"} {soldOut[k].length}
            </button>
          ))}
          <input
            value={soldQuery}
            onChange={(e) => setSoldQuery(e.target.value)}
            placeholder="상품명(일본어·한글)·옵션 검색"
            className="h-7 w-48 rounded border px-2 text-xs"
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="mb-2 text-[11px] text-muted-foreground">
            {soldKind === "temp"
              ? "목록에 SOLD OUT 으로 보이고 재입고 알림을 받는 옵션 · 재고를 넣은 뒤 신청 목록에서 골라 보내면 대기 인원에게 알림"
              : "Shopify 태그 「販売終了」가 붙은 품절 옵션 · 목록에서 숨고 알림을 받지 않음"}
          </p>
          {soldOutQuery.isLoading && <p className="mb-2 text-xs text-muted-foreground">품절 목록 불러오는 중… (쇼핑몰 옵션 전체를 확인해 조금 걸립니다)</p>}
          {(soldOutQuery.data?.soldOutError || soldOutQuery.error) && (
            <p className="mb-2 text-xs text-red-600">
              품절 목록을 불러오지 못했습니다: {soldOutQuery.data?.soldOutError ?? (soldOutQuery.error instanceof Error ? soldOutQuery.error.message : "")}
            </p>
          )}
          <table className="w-full text-xs">
            <thead className="border-b text-muted-foreground">
              <tr className="[&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium [&>th:not(.text-right)]:text-left">
                <th>상품명 (일본어 · 한글)</th><th>품절 옵션</th><th className="text-right">알림 대기</th>
              </tr>
            </thead>
            <tbody>
              {soldShown.length === 0 && (
                <tr><td colSpan={3} className="py-6 text-center text-muted-foreground">해당하는 품절 상품이 없습니다.</td></tr>
              )}
              {soldPage.items.map((p) => (
                <tr key={p.productId} className="border-b last:border-0 [&>td]:py-2 [&>td]:pr-3 [&>td]:align-top">
                  <td className="min-w-[220px]">
                    <a href={productLink(p.productId)} target="_blank" rel="noopener noreferrer" className="hover:underline">{p.title}</a>
                    <p className="text-muted-foreground">
                      {p.titleKo ?? "—"}
                      {p.titleKoSource === "ai" && <span className="ml-1 rounded bg-muted px-1 text-[10px]">자동 번역</span>}
                    </p>
                  </td>
                  <td className="min-w-[160px]">
                    {p.all && p.variants.length === p.variantCount ? (
                      <span className="font-semibold">전체 품절</span>
                    ) : null}
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {p.variants.filter((v) => v.title).map((v) => (
                        <span key={v.id} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{v.title}</span>
                      ))}
                    </div>
                    {p.variantCount > 1 && <p className="text-[10px] text-muted-foreground mt-0.5">옵션 {p.variantCount}개 중 {p.variants.length}개</p>}
                  </td>
                  <td className="text-right tabular-nums">{p.waiting > 0 ? <span className="font-semibold">{p.waiting}명</span> : <span className="text-muted-foreground">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager p={soldPage} />
          <p className="mt-2 text-[11px] text-muted-foreground">
            한글 상품명은 Shopify 상품 메타필드 <code>custom.name_ko</code> 에 적어 두면 그 값을 쓰고, 없으면 AI 가 번역합니다(「자동 번역」).
          </p>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Shopify 상품 태그 「販売終了」(상품 전체) · 「販売終了:옵션명」(그 옵션만)을 달면 판매 종료 — 다 팔리면 목록에서 빠지고 알림 신청을 받지 않습니다 ·{" "}
        최근 {data.ttlDays}일 신청 기준 · 같은 사람이 같은 옵션을 여러 번 누르면 한 건 · 고객 이름은 LINE 공식계정 친구일 때만 보입니다 ·{" "}
        보낼 때 재고를 다시 확인해 그새 다시 품절된 신청은 빼고 보냅니다 · 한 번에 최대 {data.maxPerSend ?? 200}명
      </p>
    </div>
  );
}
