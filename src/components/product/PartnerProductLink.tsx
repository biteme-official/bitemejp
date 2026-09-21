/**
 * 상품 상세의 어필리에이트 박스 — 「この商品をシェアして、売上の10%をもらおう」 (#178, 하영 요청 2026-09-21)
 *
 * 세 가지 상태를 한 자리에서 다룬다 (지그재그 크리에이터 라운지 방식: 상품 페이지의 훅 → 바텀시트 → 그 자리에서 참여).
 *   - 파트너        → 이 상품의 紹介リンク 복사 (biteme.co.jp/a/CODE?p=/product/ID)
 *   - 회원(미가입)  → 「参加する」 → 바텀시트: 특전 3줄 + 체크박스 2개(18세·약관) → 등록 → 바로 링크 복사
 *   - 비로그인      → 「LINEで参加」 → 바텀시트 → LINE 로그인 → 이 페이지로 돌아와 시트가 다시 열림(?join=1)
 * 요율은 기본 10% 이되, 파트너·이 상품에 적용 중인 캠페인이 있으면 그 요율(최대)을 보여준다.
 *
 * 파트너 여부·캠페인은 세션 동안 한 번만 묻는다(sessionStorage) — 상품을 볼 때마다 API 를 부르지 않기 위해.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Copy, Check, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/authStore";
import { initiateLineLogin } from "@/lib/line-auth";
import { AffiliateApiError, fetchPartnerView, joinAffiliate } from "@/lib/affiliate-api";
import { AFFILIATE_TERMS_VERSION } from "@/data/affiliate-terms";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

const CACHE_KEY = "aff_partner_v2";
const BASE_RATE = 0.1;
/** 로그인 후 돌아왔을 때 시트를 다시 여는 표식 */
const JOIN_PARAM = "join";

interface Cached {
  t: string;
  /** 활동 파트너 코드. null = 파트너 아님(회원) */
  code: string | null;
  campaigns: Array<{ scope: string; rate: number; targetIds: string[]; endsAt: string }>;
}

function readCache(token: string): Cached | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Cached;
    return v.t === token.slice(-16) ? v : null; // 토큰이 바뀌었으면(재로그인) 캐시를 버린다
  } catch { return null; }
}
function writeCache(token: string, code: string | null, campaigns: Cached["campaigns"]) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: token.slice(-16), code, campaigns } satisfies Cached)); } catch { /* 무시 */ }
}

/** 이 상품에 적용되는 요율 — 전원/지정 파트너 캠페인 또는 이 상품을 지정한 캠페인 중 최대, 없으면 기본 10% */
function rateFor(campaigns: Cached["campaigns"], productId: string): number {
  const now = Date.now();
  const rates = campaigns
    .filter((c) => new Date(c.endsAt).getTime() > now)
    .filter((c) => c.scope !== "products" || c.targetIds.includes(productId))
    .map((c) => c.rate);
  return Math.max(BASE_RATE, ...rates);
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function PartnerProductLink({ productNumericId }: { productNumericId: string | null }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, isLoggedIn, logout } = useAuthStore();
  const token = isLoggedIn ? user?.lineSessionToken : undefined;
  const [info, setInfo] = useState<Cached | null | "loading">(token ? "loading" : null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [adult, setAdult] = useState(false);
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) { setInfo(null); return; }
    const cached = readCache(token);
    if (cached) { setInfo(cached); return; }
    let alive = true;
    setInfo("loading");
    fetchPartnerView(token)
      .then((v) => {
        if (!alive) return;
        const code = v.partner.status === "active" ? v.partner.code : null;
        const campaigns = v.campaigns.map((c) => ({ scope: c.scope, rate: c.commissionRate, targetIds: c.targetIds ?? [], endsAt: c.endsAt }));
        writeCache(token, code, campaigns);
        setInfo({ t: token.slice(-16), code, campaigns });
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof AffiliateApiError && e.code === "not_partner") { writeCache(token, null, []); setInfo({ t: token.slice(-16), code: null, campaigns: [] }); return; }
        if (e instanceof AffiliateApiError && e.code === "unauthorized") { logout(); setInfo(null); return; } // 30일 세션 만료 — 비로그인으로 취급
        setInfo(null);
      });
    return () => { alive = false; };
  }, [token, logout]);

  // LINE 로그인에서 돌아오면(?join=1) 시트를 다시 연다
  useEffect(() => {
    if (searchParams.get(JOIN_PARAM) === "1" && token) setOpen(true);
  }, [searchParams, token]);

  if (!productNumericId || info === "loading") return null;
  const partnerCode = info?.code ?? null;
  const pct = Math.round(rateFor(info?.campaigns ?? [], productNumericId) * 100);
  const linkFor = (code: string) => `${window.location.origin}/a/${code}?p=/product/${productNumericId}`;

  const copyLink = async (code: string) => {
    if (await copyText(linkFor(code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("紹介リンクをコピーしました。ストーリーズに貼ってシェアしよう", { position: "top-center" });
    } else {
      toast.error("コピーできませんでした。長押しでコピーしてください。");
    }
  };

  const startLogin = () => {
    // 돌아올 곳 = 이 상품 페이지 + ?join=1 — 로그인 직후 시트가 다시 열려 흐름이 끊기지 않는다
    const returnTo = `${window.location.pathname}?${JOIN_PARAM}=1`;
    initiateLineLogin({ returnTo, src: "button" }).catch(() => toast.error("LINEログインを開始できませんでした"));
  };

  const submitJoin = async () => {
    if (!token || submitting) return;
    if (!adult || !agree) { toast.error("年齢の確約と規約への同意が必要です。"); return; }
    setSubmitting(true);
    try {
      const r = await joinAffiliate({ lineSessionToken: token, name: user?.displayName, termsVersion: AFFILIATE_TERMS_VERSION });
      writeCache(token, r.partner.code, []);
      setInfo({ t: token.slice(-16), code: r.partner.code, campaigns: [] });
      toast.success(r.created ? "パートナー登録が完了しました" : "すでに登録済みです");
    } catch (e) {
      const code = e instanceof AffiliateApiError ? e.code : "";
      if (code === "not_member") toast.error("会員情報を確認できませんでした。一度ログアウトし、LINEで再ログインしてからお試しください。");
      else if (code === "not_eligible") toast.error("このアカウントは現在ご参加いただけません。");
      else if (code === "unauthorized") { logout(); toast.error("ログインの有効期限が切れました。もう一度LINEでログインしてください。"); setOpen(false); }
      else toast.error("登録に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

  const guest = !token;
  return (
    <>
      {/* 박스 — 파트너면 복사, 아니면 참여 훅. 문구는 셋 다 같은 한 줄 */}
      <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-3 flex items-center gap-3">
        <Sparkles className="h-5 w-5 text-primary shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">この商品をシェアして、売上の{pct}%をもらおう</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{partnerCode ? "リンクをコピーしてストーリーズに貼るだけ" : "審査なし・登録は1分。リンクを貼るだけで報酬に"}</p>
        </div>
        {partnerCode ? (
          <button onClick={() => copyLink(partnerCode)} className="shrink-0 inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-2 text-xs font-semibold whitespace-nowrap" aria-label="紹介リンクをコピー">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            リンクをコピー
          </button>
        ) : (
          <button onClick={() => setOpen(true)} className="shrink-0 rounded-md bg-primary text-primary-foreground px-3 py-2 text-xs font-semibold whitespace-nowrap">
            {guest ? "LINEで参加" : "参加する"}
          </button>
        )}
      </div>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-md px-4 pb-6">
            {partnerCode ? (
              <>
                <DrawerHeader className="px-0 text-left">
                  <DrawerTitle>登録が完了しました</DrawerTitle>
                  <DrawerDescription>この商品の紹介リンクです。ストーリーズやプロフィールに貼ってシェアしよう。</DrawerDescription>
                </DrawerHeader>
                <div className="flex items-center gap-2 mb-3">
                  <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 text-xs" translate="no">{linkFor(partnerCode)}</code>
                  <Button size="sm" onClick={() => copyLink(partnerCode)} aria-label="コピー">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button>
                </div>
                <p className="text-[11px] text-muted-foreground">成果や報酬は <button className="underline" onClick={() => navigate("/partner")}>パートナーページ</button> で確認できます。投稿には「#PR」表示をお忘れなく。</p>
              </>
            ) : (
            <>
            <DrawerHeader className="px-0 text-left">
              <DrawerTitle>BITE ME パートナーになる</DrawerTitle>
              <DrawerDescription>お気に入りの商品を紹介して、報酬を受け取る。</DrawerDescription>
            </DrawerHeader>
            <ul className="space-y-2 text-sm mb-5">
              <li className="flex gap-2"><span className="text-primary font-bold">10%</span><span>紹介リンク経由のご注文（商品代金・割引後）の{pct}%が報酬に。月末締め・翌月末払い</span></li>
              <li className="flex gap-2"><span className="text-primary font-bold">1分</span><span>審査なし。登録と同時に紹介リンクが発行されます</span></li>
              <li className="flex gap-2"><span className="text-primary font-bold">条件</span><span>成果対象はお客様が<b>LINEログイン後</b>に行ったご注文のみ。投稿には「#PR」等の広告表示が必要です</span></li>
            </ul>

            {guest ? (
              <>
                <button onClick={startLogin} className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-md text-white font-medium text-sm bg-[#06C755] hover:opacity-90">
                  LINEでログインして参加する
                </button>
                <p className="text-[11px] text-muted-foreground text-center mt-2">ログイン後、この商品ページに戻ります</p>
              </>
            ) : (
              <>
                <div className="space-y-3 text-sm mb-4">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <Checkbox checked={adult} onCheckedChange={(v) => setAdult(v === true)} className="mt-0.5" />
                    <span>満18歳以上です</span>
                  </label>
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} className="mt-0.5" />
                    <span>
                      <button type="button" className="underline hover:text-primary" onClick={(e) => { e.preventDefault(); navigate("/affiliate/terms"); }}>利用規約</button>
                      ・
                      <button type="button" className="underline hover:text-primary" onClick={(e) => { e.preventDefault(); navigate("/affiliate/terms#guideline"); }}>広告表示ガイドライン</button>
                      に同意します
                    </span>
                  </label>
                </div>
                <Button className="w-full" onClick={submitJoin} disabled={submitting || !adult || !agree}>
                  {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />登録中...</> : "登録してこの商品のリンクを受け取る"}
                </Button>
                <p className="text-[11px] text-muted-foreground text-center mt-2">{user?.displayName} さんとして登録します</p>
              </>
            )}
            </>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
