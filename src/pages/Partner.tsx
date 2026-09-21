/**
 * /partner — 파트너 본인 화면 (#178 Phase 2, 설계 §7)
 *
 * 맨 위는 링크 복사 — 매일 여는 이유는 그것 하나다. 아래로 퍼널 4단, 이달 커미션, 캠페인, 명세.
 * 약관이 요구하는 것도 여기 산다: 別紙 링크(第8条), 등록번호 입력(第3条 3항), 참가 종료(第12条 1항),
 * 이의신청은 지급일 + 30일(第5条 5항 — 정산이 생기는 Phase 3 에서 버튼 활성).
 * 성과는 건수·금액·일시뿐, 구매자 정보는 API 가 애초에 내보내지 않는다(第10条 3항).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ChevronLeft, Copy, Check, ExternalLink, Loader2, Megaphone, User } from "lucide-react";
import { Footer } from "@/components/layout/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LineLoginButton } from "@/components/auth/LineLoginButton";
import { useAuthStore } from "@/stores/authStore";
import { AffiliateApiError, fetchPartnerView, saveInvoiceRegNo, withdrawPartner, type PartnerView } from "@/lib/affiliate-api";
import { AFFILIATE_TERMS_VERSION } from "@/data/affiliate-terms";
import biteMeLogo from "@/assets/bite-me-logo.png";

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tokyo" });
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

const STATUS_JA: Record<string, string> = {
  pending: "確定待ち", confirmed: "確定", reversed: "取消", self: "対象外（本人）", void: "対象外", nonmember: "対象外（非会員）",
};

function PageFrame({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="bg-background min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 bg-background border-b border-border">
        <div className="flex items-center gap-2 px-4 h-14">
          <button onClick={() => navigate(-1)} className="p-1 text-foreground" aria-label="戻る"><ChevronLeft className="h-5 w-5" /></button>
          <button onClick={() => navigate("/")} className="hover:opacity-80 transition-opacity"><img src={biteMeLogo} alt="BITE ME" className="h-[17px]" /></button>
          <span className="ml-auto text-xs text-muted-foreground">パートナーページ</span>
        </div>
      </header>
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-6 space-y-6">{children}</main>
      <Footer />
    </div>
  );
}

export default function Partner() {
  const navigate = useNavigate();
  const { user, isLoggedIn, logout } = useAuthStore();
  const token = user?.lineSessionToken;
  const [view, setView] = useState<PartnerView | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "not_partner" | "error">("loading");
  const [copied, setCopied] = useState(false);
  const [invoice, setInvoice] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isLoggedIn || !token) { setState("loading"); return; }
    setState("loading");
    fetchPartnerView(token)
      .then((v) => { setView(v); setInvoice(v.partner.invoiceRegNo ?? ""); setState("ok"); })
      .catch((e) => {
        if (e instanceof AffiliateApiError && e.code === "unauthorized") {
          // 30일 세션 만료 — 옛 로그인이 남아 있으면 로그인 상태를 지워 LINE 버튼을 보여준다
          logout();
          toast.error("ログインの有効期限が切れました。もう一度LINEでログインしてください。");
          return;
        }
        setState(e instanceof AffiliateApiError && e.code === "not_partner" ? "not_partner" : "error");
      });
  }, [isLoggedIn, token, logout]);

  if (!isLoggedIn || !token) {
    return (
      <PageFrame>
        <div className="max-w-md mx-auto py-10 flex flex-col items-center text-center">
          <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-6"><User className="h-10 w-10 text-muted-foreground" /></div>
          <h1 className="text-xl font-bold mb-2">ログインしてください</h1>
          <p className="text-sm text-muted-foreground mb-8">パートナーページを利用するには<br />LINEアカウントでのログインが必要です。</p>
          <div className="w-full"><LineLoginButton /></div>
        </div>
      </PageFrame>
    );
  }

  if (state === "loading") {
    return <PageFrame><div className="py-16 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></PageFrame>;
  }
  if (state === "not_partner") {
    return (
      <PageFrame>
        <div className="max-w-md mx-auto py-10 text-center space-y-4">
          <h1 className="text-xl font-bold">まだパートナー登録がありません</h1>
          <p className="text-sm text-muted-foreground">登録は1分で完了します。紹介リンクはその場で発行されます。</p>
          <Button onClick={() => navigate("/partner/join")}>パートナー登録へ</Button>
        </div>
      </PageFrame>
    );
  }
  if (state === "error" || !view) {
    return <PageFrame><p className="text-sm text-muted-foreground text-center py-16">読み込みに失敗しました。時間をおいて再度お試しください。</p></PageFrame>;
  }

  const { partner, funnel, commission, recent, campaigns, payouts } = view;
  const withdrawn = partner.status === "withdrawn";
  const suspended = partner.status === "suspended";

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(partner.link); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { toast.error("コピーできませんでした。長押しでコピーしてください。"); }
  };

  const onSaveInvoice = async () => {
    setBusy(true);
    try { const r = await saveInvoiceRegNo(token, invoice); setView({ ...view, partner: r.partner }); toast.success(invoice ? "登録番号を保存しました" : "登録番号を削除しました"); }
    catch (e) { toast.error(e instanceof AffiliateApiError && e.code === "invalid_invoice_no" ? "登録番号は T + 13桁の数字です" : "保存に失敗しました"); }
    finally { setBusy(false); }
  };

  const onWithdraw = async () => {
    if (!window.confirm("参加を終了すると紹介リンクは直ちに無効になります。確定済みの成果報酬は規約に従ってお支払いします。終了しますか？")) return;
    setBusy(true);
    try { const r = await withdrawPartner(token); setView({ ...view, partner: r.partner }); toast.success("参加を終了しました"); }
    catch { toast.error("処理に失敗しました"); }
    finally { setBusy(false); }
  };

  return (
    <PageFrame>
      {withdrawn && <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">参加を終了しています。紹介リンクは無効です。確定済みの成果報酬は規約第5条に従ってお支払いします。</div>}
      {suspended && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">参加を停止しています。お心当たりがない場合はお問い合わせください。</div>}
      {partner.termsVersion && partner.termsVersion !== AFFILIATE_TERMS_VERSION && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
          利用規約が改定されました（版 {AFFILIATE_TERMS_VERSION}）。<button className="underline ml-1" onClick={() => navigate("/affiliate/terms")}>内容を確認する</button>
        </div>
      )}

      {/* 링크 — 맨 위 */}
      <section className="rounded-2xl bg-primary text-primary-foreground px-5 py-5 space-y-3">
        <p className="text-xs font-medium opacity-90">あなたの紹介リンク</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md bg-white/15 px-3 py-2 text-sm">{withdrawn ? "—" : partner.link}</code>
          <Button variant="secondary" size="sm" onClick={copyLink} disabled={withdrawn} aria-label="コピー">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed opacity-90">
          成果対象は <b>LINEログイン後のご注文のみ</b>です。フォロワーには「LINEログインでウェルカムクーポン10%」をご案内ください。
          投稿には <b>#PR</b> 表示が必要です（<button className="underline" onClick={() => navigate("/affiliate/terms#guideline")}>広告表示ガイドライン</button>）。
        </p>
      </section>

      {/* 상품 링크 만들기 — 상품 페이지의 「コピー」 버튼과 같은 결과. 주소를 붙여넣는 사람을 위해 */}
      {!withdrawn && (
        <section className="rounded-xl border border-border px-4 py-3 space-y-2">
          <p className="text-sm font-medium">商品リンクを作る</p>
          <p className="text-[11px] text-muted-foreground">商品ページの URL を貼り付けると、その商品に直接飛ぶ紹介リンクになります。商品ページの「パートナー：コピー」ボタンでも同じリンクが取れます。</p>
          <div className="flex gap-2">
            <Input value={productUrl} onChange={(e) => setProductUrl(e.target.value)} placeholder="https://biteme.co.jp/product/1234567890" />
            <Button variant="outline" onClick={async () => {
              const m = productUrl.match(/\/product\/(\d+)/);
              if (!m) { toast.error("商品ページの URL（/product/番号）を貼り付けてください"); return; }
              const link = `${partner.link}?p=/product/${m[1]}`;
              try { await navigator.clipboard.writeText(link); toast.success("商品の紹介リンクをコピーしました"); } catch { toast.error("コピーできませんでした"); }
            }}>コピー</Button>
          </div>
        </section>
      )}

      {/* 캠페인 */}
      {campaigns.length > 0 && (
        <section className="space-y-2">
          {campaigns.map((c) => (
            <div key={c.name} className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm flex gap-3">
              <Megaphone className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">{c.name} — 報酬率 {pct(c.commissionRate)}{c.discountPercent ? ` · お客様割引 ${c.discountPercent}%` : ""}</p>
                <p className="text-xs text-muted-foreground">{day(c.startsAt)} 〜 {day(c.endsAt)}{c.code ? ` · 専用クーポン ${c.code}` : ""}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* 퍼널 + 이달 */}
      <section>
        <p className="text-xs text-muted-foreground mb-2">今月（{day(view.monthStart)} 〜）</p>
        <div className="grid grid-cols-4 gap-2">
          {[["クリック", funnel.clicks], ["注文", funnel.orders], ["確定", funnel.confirmed], ["支払済", funnel.paid]].map(([k, v]) => (
            <div key={String(k)} className="rounded-xl border border-border bg-card px-3 py-3 text-center">
              <p className="text-[11px] text-muted-foreground">{k}</p>
              <p className="text-lg font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="rounded-xl border border-border bg-card px-4 py-3"><p className="text-[11px] text-muted-foreground">今月の報酬（確定待ち）</p><p className="text-lg font-semibold tabular-nums">{yen(commission.pendingThisMonth)}</p></div>
          <div className="rounded-xl border border-border bg-card px-4 py-3"><p className="text-[11px] text-muted-foreground">確定済み・未払い</p><p className="text-lg font-semibold tabular-nums">{yen(commission.confirmedUnpaid)}</p></div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">成果は注文日から30日後に確定し、月末締め・翌月末払い（3,000円未満は繰越）です。</p>
      </section>

      {/* 명세 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">成果明細</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground rounded-xl border border-dashed border-border px-4 py-6 text-center">まだ成果はありません。リンクをシェアして始めましょう。</p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground"><tr><th className="text-left px-3 py-2 font-medium">注文日</th><th className="text-right px-3 py-2 font-medium">対象額</th><th className="text-right px-3 py-2 font-medium">報酬</th><th className="text-left px-3 py-2 font-medium">状態</th></tr></thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i} className="border-t border-border/60">
                    <td className="px-3 py-2">{day(r.orderedAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{yen(r.amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{yen(r.commission)}</td>
                    <td className="px-3 py-2">{STATUS_JA[r.status] ?? r.status}{r.status === "pending" ? <span className="text-muted-foreground"> · {day(r.confirmAt)}確定</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 정산 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">お支払い</h2>
        {payouts.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだお支払い実績はありません。明細への異議はお支払い日から30日以内に承ります。</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {payouts.map((p) => (
              <li key={p.period} className="flex justify-between rounded-lg border border-border px-4 py-2">
                <span>{p.period}</span><span className="tabular-nums">{yen(p.net)} · {p.status === "paid" ? `支払済 ${p.paid_at ? day(p.paid_at) : ""}` : p.status === "carried" ? "繰越" : "支払予定"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 설정 */}
      <section className="space-y-4 rounded-xl border border-border px-4 py-4">
        <div>
          <label className="text-sm font-medium" htmlFor="invoice">適格請求書発行事業者 登録番号（任意）</label>
          <p className="text-[11px] text-muted-foreground mb-2">登録事業者の方のみ。T + 13桁。報酬は消費税込（内税）でお支払いします。</p>
          <div className="flex gap-2">
            <Input id="invoice" value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="T1234567890123" disabled={busy || withdrawn} />
            <Button variant="outline" onClick={onSaveInvoice} disabled={busy || withdrawn}>保存</Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <button className="underline inline-flex items-center gap-1" onClick={() => navigate("/affiliate/terms")}>利用規約 <ExternalLink className="h-3 w-3" /></button>
          <button className="underline inline-flex items-center gap-1" onClick={() => navigate("/affiliate/terms#guideline")}>広告表示ガイドライン <ExternalLink className="h-3 w-3" /></button>
          <button className="underline inline-flex items-center gap-1" onClick={() => navigate("/contact")}>お問い合わせ・異議申立 <ExternalLink className="h-3 w-3" /></button>
        </div>
        {!withdrawn && (
          <div className="pt-2 border-t border-border">
            <button className="text-xs text-muted-foreground underline" onClick={onWithdraw} disabled={busy}>参加を終了する</button>
          </div>
        )}
      </section>
    </PageFrame>
  );
}
