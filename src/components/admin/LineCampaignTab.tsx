import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Send, FlaskConical, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const ADMIN_API_BASE = (import.meta.env.VITE_ADMIN_API_BASE_URL as string) ?? "";

// ─── 타입 ────────────────────────────────────────────────────────────────────

interface Segment {
  purchase: "any" | "buyers" | "non_buyers";
  email: "any" | "real" | "placeholder";
  signupWithinDays: number | null;
  signupBeforeDays: number | null;
  source: string | null;
}

interface AudienceSummary {
  count: number;
  buyers: number;
  nonBuyers: number;
  realEmail: number;
  placeholderEmail: number;
  unreachable: number;
  totalSpent: number;
  bySource: Record<string, number>;
  byMonth: Record<string, number>;
}

interface StatusResponse {
  quota: { limit: number | null; used: number; remaining: number | null };
  followers: { followers: number; targetedReaches: number; blocks: number } | null;
  audience: AudienceSummary;
  history: {
    sentAt: string;
    campaignId: string;
    campaign?: string;
    name?: string | null;
    test?: boolean;
    recipients?: number;
    sent?: number;
  }[];
}

interface PreviewResponse {
  total: number;
  matched: AudienceSummary;
  preview: { text: string; campaign: string; campaignId: string } | null;
  messageError: string | null;
}

interface SendResponse {
  ok: boolean;
  campaignId: string;
  recipients: number;
  sent: number;
  failedChunks: number;
  error?: string;
}

const EMPTY_SEGMENT: Segment = {
  purchase: "any",
  email: "any",
  signupWithinDays: null,
  signupBeforeDays: null,
  source: null,
};

// ─── API ─────────────────────────────────────────────────────────────────────

async function call<T>(secret: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ADMIN_API_BASE}/api/line-campaign`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(data.error || "LINE 발송 API 오류");
  return data as T;
}

// ─── 작은 조각들 ─────────────────────────────────────────────────────────────

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function Choice<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
            value === o.value
              ? "border-primary bg-primary text-primary-foreground"
              : "bg-background hover:bg-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── 본체 ────────────────────────────────────────────────────────────────────

export default function LineCampaignTab({ secret }: { secret: string }) {
  const [segment, setSegment] = useState<Segment>(EMPTY_SEGMENT);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [testIds, setTestIds] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const status = useQuery({
    queryKey: ["line-campaign-status", secret],
    queryFn: () => call<StatusResponse>(secret),
    staleTime: 5 * 60 * 1000,
  });

  const preview = useQuery({
    queryKey: ["line-campaign-preview", secret, segment, name, text, url],
    queryFn: () =>
      call<PreviewResponse>(secret, {
        action: "preview",
        segment,
        message: { name, text, url: url || undefined },
      }),
    staleTime: 60 * 1000,
  });

  const send = useMutation({
    mutationFn: (opts: { test: boolean }) =>
      call<SendResponse>(secret, {
        action: "send",
        confirm: true,
        segment,
        message: { name, text, url: url || undefined },
        ...(opts.test
          ? { testUserIds: testIds.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) }
          : {}),
      }),
    onSuccess: (r) => {
      setResult(
        r.failedChunks > 0
          ? `⚠️ 일부 실패 — ${r.sent}/${r.recipients}명 발송 (${r.campaignId})`
          : `✅ ${r.sent}명에게 발송했습니다 (${r.campaignId})`,
      );
      status.refetch();
    },
    onError: (e: Error) => setResult(`🔴 ${e.message}`),
  });

  const matched = preview.data?.matched;
  const reachable = matched ? matched.count - matched.unreachable : 0;
  const quotaRemaining = status.data?.quota.remaining ?? null;
  const quotaShort = quotaRemaining !== null && reachable > quotaRemaining;
  const canSend = !!text.trim() && !!name.trim() && !preview.data?.messageError;

  const sources = Object.keys(status.data?.audience.bySource ?? {});

  return (
    <div className="space-y-5">
      {/* ── 현황 ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label="친구"
          value={status.data?.followers ? status.data.followers.followers.toLocaleString() : "—"}
          hint={status.data?.followers ? `차단 ${status.data.followers.blocks.toLocaleString()}` : "인사이트 2일 지연"}
        />
        <Stat
          label="발송 가능"
          value={status.data?.followers ? status.data.followers.targetedReaches.toLocaleString() : "—"}
          hint="브로드캐스트 1회 통수"
        />
        <Stat
          label="남은 쿼터"
          value={quotaRemaining === null ? "무제한" : quotaRemaining.toLocaleString()}
          hint={status.data ? `${status.data.quota.used.toLocaleString()} / ${status.data.quota.limit?.toLocaleString() ?? "—"} 사용` : undefined}
        />
        <Stat
          label="연결 고객"
          value={status.data ? status.data.audience.count.toLocaleString() : "—"}
          hint={status.data ? `구매 ${status.data.audience.buyers} · 실이메일 ${status.data.audience.realEmail}` : undefined}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ── 세그먼트 ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">1. 누구에게 보낼까</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">구매 이력</Label>
              <Choice
                value={segment.purchase}
                onChange={(v) => setSegment({ ...segment, purchase: v })}
                options={[
                  { value: "any", label: "전체" },
                  { value: "buyers", label: "구매자" },
                  { value: "non_buyers", label: "미구매" },
                ]}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">이메일</Label>
              <Choice
                value={segment.email}
                onChange={(v) => setSegment({ ...segment, email: v })}
                options={[
                  { value: "any", label: "전체" },
                  { value: "real", label: "실이메일 보유" },
                  { value: "placeholder", label: "미등록" },
                ]}
              />
              <p className="text-[11px] text-muted-foreground">
                미등록은 주문 확인 메일이 도달하지 않는 사람들이다 — LINE 이 유일한 연락 수단.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">가입 N일 이내</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="제한 없음"
                  value={segment.signupWithinDays ?? ""}
                  onChange={(e) =>
                    setSegment({ ...segment, signupWithinDays: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">가입 N일 경과</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="제한 없음"
                  value={segment.signupBeforeDays ?? ""}
                  onChange={(e) =>
                    setSegment({ ...segment, signupBeforeDays: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </div>
            </div>

            {sources.length > 1 && (
              <div className="space-y-1.5">
                <Label className="text-xs">유입경로</Label>
                <Choice
                  value={segment.source ?? "all"}
                  onChange={(v) => setSegment({ ...segment, source: v === "all" ? null : v })}
                  options={[
                    { value: "all", label: "전체" },
                    ...sources.map((s) => ({
                      value: s === "(없음)" ? "none" : s,
                      label: `${s} ${status.data?.audience.bySource[s] ?? 0}`,
                    })),
                  ]}
                />
              </div>
            )}

            <div className="rounded-lg border bg-muted/40 p-3">
              {preview.isFetching ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 대상 계산 중…
                </p>
              ) : matched ? (
                <>
                  <p className="text-sm">
                    대상 <span className="text-lg font-semibold tabular-nums">{reachable.toLocaleString()}</span>명
                    <span className="text-xs text-muted-foreground"> / 연결 {preview.data?.total.toLocaleString()}명</span>
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    구매 {matched.buyers} · 미구매 {matched.nonBuyers} · 실이메일 {matched.realEmail} · 누적구매 ¥
                    {matched.totalSpent.toLocaleString()}
                    {matched.unreachable > 0 && ` · 발송 불가 ${matched.unreachable}명(LINE ID 없음)`}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">—</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── 메시지 ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">2. 무엇을 보낼까</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">소재명</Label>
              <Input
                placeholder="예: 가을준비페스타"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                캠페인 ID·UTM 에 쓰인다. 같은 소재명으로는 두 번 보낼 수 없다(중복 발송 방지).
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">본문</Label>
              <Textarea
                rows={7}
                placeholder={"こんにちは！\n秋の準備フェスタ、本日スタートです🍂"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">{text.length} / 900자</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">링크 (선택)</Label>
              <Input
                placeholder="https://biteme.co.jp/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                UTM 은 자동으로 붙는다 — 그래야 이 발송이 만든 주문이 잡힌다.
              </p>
            </div>

            {preview.data?.messageError && (
              <p className="text-xs text-destructive">{preview.data.messageError}</p>
            )}

            {preview.data?.preview && (
              <div className="space-y-1.5">
                <Label className="text-xs">실제로 나갈 문안</Label>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
                  {preview.data.preview.text}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 발송 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">3. 보내기</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">테스트 대상 LINE userId</Label>
              <Input
                placeholder="U 로 시작하는 ID. 여러 명이면 쉼표로"
                value={testIds}
                onChange={(e) => setTestIds(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={!canSend || !testIds.trim() || send.isPending}
              onClick={() => { setResult(null); send.mutate({ test: true }); }}
            >
              {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}
              테스트 발송
            </Button>
          </div>

          {quotaShort && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              남은 쿼터({quotaRemaining?.toLocaleString()}통)보다 대상이 많다 — 이대로는 발송이 거부된다.
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              disabled={!canSend || reachable === 0 || send.isPending || quotaShort}
              onClick={() => setConfirmOpen(true)}
            >
              <Send className="mr-2 h-4 w-4" />
              {reachable.toLocaleString()}명에게 실제 발송
            </Button>
            {result && <p className="text-sm">{result}</p>}
          </div>
        </CardContent>
      </Card>

      {/* ── 이력 ── */}
      {(status.data?.history.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">최근 발송</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {status.data!.history.map((h, i) => (
                <div key={i} className="flex items-center justify-between border-b py-1.5 text-xs last:border-0">
                  <span className="truncate">
                    {h.test && <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px]">테스트</span>}
                    {h.name || h.campaignId}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {h.sent?.toLocaleString()}명 · {new Date(h.sentAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{reachable.toLocaleString()}명에게 지금 보냅니다</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>보낸 메시지는 되돌릴 수 없다. 문안과 대상을 한 번 더 확인할 것.</p>
                <p className="rounded-md border bg-muted/40 p-2 text-xs">
                  소재 <b>{name}</b> · 대상 <b>{reachable.toLocaleString()}명</b>
                  {quotaRemaining !== null && ` · 발송 후 잔여 ${(quotaRemaining - reachable).toLocaleString()}통`}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setResult(null); send.mutate({ test: false }); }}>
              발송
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
