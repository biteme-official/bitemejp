import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Instagram, Mail, Sparkles, BadgePercent, Users, Megaphone, ChevronLeft, Loader2, CheckCircle2, Copy, Check } from "lucide-react";
import { Footer } from "@/components/layout/Footer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { LineLoginButton } from "@/components/auth/LineLoginButton";
import { useAuthStore } from "@/stores/authStore";
import { AffiliateApiError, fetchPartnerView, joinAffiliate, type PublicPartner } from "@/lib/affiliate-api";
import { AFFILIATE_TERMS_VERSION } from "@/data/affiliate-terms";
import biteMeLogo from "@/assets/bite-me-logo.png";

const BENEFITS = [
  {
    icon: BadgePercent,
    title: "成果報酬 10%",
    desc: "あなたの紹介リンク経由のご注文（商品代金・割引後）の10%を成果報酬としてお支払いします。審査はなく、登録と同時にリンクが発行されます。",
  },
  {
    icon: Megaphone,
    title: "実績に応じた特別キャンペーン",
    desc: "実績のあるパートナーには、期間限定で報酬率アップやフォロワー向け割引クーポン付きのキャンペーンをご案内します。",
  },
  {
    icon: Users,
    title: "コラボ企画",
    desc: "新商品の共同企画やイベントなど、継続的なコラボの機会をご提供します。",
  },
];

const STEPS = [
  "LINEでログインし、Instagramアカウント名を入力します。",
  "満18歳以上の確約と利用規約への同意にチェックを入れて登録すると、その場で紹介リンクが発行されます。",
  "リンクをシェアするだけ。成果はパートナーページでいつでも確認できます。",
];

/**
 * 가입 카드 — 로그인 → 체크박스 2개 → 등록 → 링크 (설계 §3·§7).
 * 이미 파트너면 링크와 파트너 페이지로 가는 버튼만 보여준다.
 */
function JoinCard() {
  const navigate = useNavigate();
  const { user, isLoggedIn, logout } = useAuthStore();
  const token = user?.lineSessionToken;
  const [instagram, setInstagram] = useState("");
  const [adult, setAdult] = useState(false);
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [partner, setPartner] = useState<PublicPartner | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  // 로그인돼 있으면 이미 파트너인지 먼저 본다 — 체크박스를 두 번 받지 않기 위해
  useEffect(() => {
    if (!isLoggedIn || !token) { setPartner(null); return; }
    setChecking(true);
    fetchPartnerView(token)
      .then((v) => setPartner(v.partner))
      .catch((e) => {
        setPartner(null);
        // 세션 토큰은 30일짜리다. 브라우저에 옛 로그인이 남아 화면은 「로그인됨」인데 서버가 거절하면
        // 로그인 상태를 지워 LINE 버튼을 보여준다 — 만료를 서버가 알려주는데 화면이 무시하면 안 된다.
        if (e instanceof AffiliateApiError && e.code === "unauthorized") { logout(); toast.error("ログインの有効期限が切れました。もう一度LINEでログインしてください。"); }
      })
      .finally(() => setChecking(false));
  }, [isLoggedIn, token, logout]);

  const submit = async () => {
    if (!token || submitting) return;
    if (!adult || !agree) { toast.error("年齢の確約と規約への同意が必要です。"); return; }
    setSubmitting(true);
    try {
      const r = await joinAffiliate({ lineSessionToken: token, name: user?.displayName, instagram: instagram.trim() || undefined, termsVersion: AFFILIATE_TERMS_VERSION });
      setPartner(r.partner);
      toast.success(r.created ? "登録が完了しました。紹介リンクを発行しました。" : "すでに登録済みです。");
    } catch (e) {
      const code = e instanceof AffiliateApiError ? e.code : "";
      if (code === "not_member") toast.error("会員情報を確認できませんでした。一度ログアウトし、LINEで再ログインしてからお試しください。");
      else if (code === "not_eligible") toast.error("このアカウントは現在ご参加いただけません。お問い合わせください。");
      else if (code === "unauthorized") { logout(); toast.error("ログインの有効期限が切れました。もう一度LINEでログインしてください。"); }
      else toast.error("登録に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!partner) return;
    try { await navigator.clipboard.writeText(partner.link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { toast.error("コピーできませんでした。"); }
  };

  if (!isLoggedIn || !token) {
    return (
      <div className="bg-card border border-border rounded-2xl px-6 py-8 space-y-4 text-center">
        <h3 className="text-lg font-semibold">LINEで参加する</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">パートナー登録にはLINEログイン（会員登録）が必要です。ログイン後、この画面に戻ります。</p>
        <LineLoginButton />
      </div>
    );
  }

  if (checking) {
    return <div className="bg-card border border-border rounded-2xl px-6 py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (partner) {
    return (
      <div className="bg-card border border-border rounded-2xl px-6 py-8 text-center space-y-4">
        <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
        <h3 className="text-lg font-semibold">{partner.status === "active" ? "パートナー登録済み" : "参加は終了しています"}</h3>
        {partner.status === "active" && (
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 text-sm">{partner.link}</code>
            <Button variant="outline" size="sm" onClick={copy} aria-label="コピー">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button>
          </div>
        )}
        <Button className="w-full" onClick={() => navigate("/partner")}>パートナーページへ</Button>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-2xl px-6 py-8 space-y-5">
      <div className="text-center space-y-1">
        <h3 className="text-lg font-semibold">パートナー登録</h3>
        <p className="text-xs text-muted-foreground">{user?.displayName} さんとして登録します</p>
      </div>
      <div className="space-y-2">
        <label htmlFor="aff-ig" className="text-sm font-medium flex items-center gap-1.5"><Instagram className="h-4 w-4 text-primary" />Instagramアカウント（任意）</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">@</span>
          <Input id="aff-ig" value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="your_account" autoComplete="off" className="pl-7" disabled={submitting} />
        </div>
      </div>
      <div className="space-y-3 text-sm">
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
      <Button className="w-full" onClick={submit} disabled={submitting || !adult || !agree}>
        {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />登録中...</> : "登録して紹介リンクを受け取る"}
      </Button>
      <p className="text-[11px] text-muted-foreground/80 leading-relaxed text-center">
        成果対象は、お客様がLINEログイン後に行ったご注文のみです。投稿には「#PR」等の広告表示が必要です。
      </p>
    </div>
  );
}

/**
 * /partner/join — 셀프 가입 페이지 (#178 Phase 2).
 * 소프트 오픈 동안은 이 주소로만 열고 /affiliate 는 옛 문구를 유지한다(설계 §10 — 내부 3명이 먼저 완주).
 * 공개 결정이 나면 /affiliate 라우트를 이 컴포넌트로 바꾸는 한 줄 PR 로 문을 연다.
 */
export default function AffiliateJoin() {
  const navigate = useNavigate();
  const [instagram, setInstagram] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    if (!instagram.trim() || !email.trim()) {
      toast.error("Instagramアカウントとメールアドレスをご入力ください。");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/affiliate-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagram: instagram.trim(), email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data?.error === "invalid_instagram") {
          toast.error("Instagramアカウント名をご確認ください。");
        } else if (data?.error === "invalid_email") {
          toast.error("メールアドレスの形式をご確認ください。");
        } else {
          toast.error("送信に失敗しました。時間をおいて再度お試しください。");
        }
        return;
      }

      if (data?.duplicate) {
        toast.success("すでにご応募済みです。順番にご連絡いたしますので、お待ちください。");
      }
      setDone(true);
    } catch {
      toast.error("送信に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-background min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 bg-background border-b border-border">
        <div className="flex items-center gap-2 px-4 h-14">
          <button onClick={() => navigate(-1)} className="p-1 text-foreground" aria-label="戻る">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button onClick={() => navigate("/")} className="hover:opacity-80 transition-opacity">
            <img src={biteMeLogo} alt="BITE ME" className="h-[17px]" />
          </button>
        </div>
      </header>

      <main className="flex-1">
        {/* ヒーロー */}
        <section className="bg-gradient-to-b from-primary/10 to-background px-4 pt-12 pb-10">
          <div className="max-w-2xl mx-auto text-center space-y-4">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Affiliate Collab
            </span>
            <h1 className="text-3xl md:text-4xl font-bold leading-tight">
              BITE ME JAPAN<br />アフィリエイト募集
            </h1>
            <div className="text-muted-foreground leading-relaxed space-y-3">
              <p>
                BITE MEの商品をご愛用いただいている皆さまと、一緒に商品の魅力を届けるアフィリエイトパートナーを募集しています。
              </p>
              <p>
                ご購入・ご使用いただいたお気に入りの商品を、Instagramを通じてフォロワーの皆さまにご紹介ください。
              </p>
            </div>
          </div>
        </section>

        {/* オープン記念コミッション */}
        <section className="max-w-2xl mx-auto px-4 -mt-4">
          <div className="rounded-2xl bg-primary text-primary-foreground px-6 py-7 text-center shadow-sm">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold">
              <BadgePercent className="h-3.5 w-3.5" />
              成果報酬
            </span>
            <div className="mt-3 flex items-end justify-center gap-1">
              <span className="text-6xl font-extrabold leading-none tracking-tight">10</span>
              <span className="text-3xl font-bold pb-1">%</span>
            </div>
            <p className="mt-2 text-sm font-medium">ご紹介いただいた売上のコミッション率</p>
            <p className="mt-2 text-xs text-primary-foreground/80 leading-relaxed">
              審査なし・登録と同時にリンク発行。成果対象は<b>LINEログイン後のご注文のみ</b>です。
            </p>
          </div>
        </section>

        {/* 特典 */}
        <section className="max-w-2xl mx-auto px-4 py-10 space-y-4">
          <h2 className="text-lg font-semibold text-center">パートナー特典</h2>
          <div className="grid grid-cols-1 gap-3">
            {BENEFITS.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex gap-3 bg-card border border-border rounded-xl px-4 py-4">
                <div className="shrink-0 h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 流れ */}
        <section className="max-w-2xl mx-auto px-4 pb-10 space-y-4">
          <h2 className="text-lg font-semibold text-center">参加の流れ</h2>
          <ol className="space-y-3">
            {STEPS.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <p className="text-sm text-muted-foreground leading-relaxed pt-0.5">{step}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* 가입 */}
        <section className="max-w-md mx-auto px-4 pb-10">
          <JoinCard />
        </section>

        {/* 応募フォーム — LINE をお持ちでない方・コラボのご相談 (시트 접수, 그대로 둔다) */}
        <section className="max-w-md mx-auto px-4 pb-16">
          <p className="text-xs text-muted-foreground text-center mb-3">LINEをお持ちでない方・企業/事務所からのコラボのご相談はこちら</p>
          {done ? (
            <div className="bg-card border border-border rounded-2xl px-6 py-10 text-center space-y-3">
              <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
              <h3 className="text-lg font-semibold">お問い合わせありがとうございます</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                内容を確認のうえ、ご登録のメール宛てにご連絡いたします。今しばらくお待ちください。
              </p>
              <Button variant="outline" className="mt-2" onClick={() => navigate("/")}>
                トップへ戻る
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl px-6 py-8 space-y-5">
              <div className="text-center space-y-1">
                <h3 className="text-lg font-semibold">お問い合わせ</h3>
                <p className="text-xs text-muted-foreground">
                  Instagramアカウントとメールアドレスをご登録ください。担当者からご連絡します。
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="aff-instagram" className="text-sm font-medium flex items-center gap-1.5">
                  <Instagram className="h-4 w-4 text-primary" />
                  Instagramアカウント
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">@</span>
                  <Input
                    id="aff-instagram"
                    value={instagram}
                    onChange={(e) => setInstagram(e.target.value)}
                    placeholder="your_account"
                    autoComplete="off"
                    className="pl-7"
                    disabled={submitting}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="aff-email" className="text-sm font-medium flex items-center gap-1.5">
                  <Mail className="h-4 w-4 text-primary" />
                  メールアドレス
                </label>
                <Input
                  id="aff-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="example@email.com"
                  autoComplete="email"
                  disabled={submitting}
                />
              </div>

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    送信中...
                  </>
                ) : (
                  "送信する"
                )}
              </Button>

              <p className="text-[11px] text-muted-foreground/70 leading-relaxed text-center">
                ご入力いただいた情報は、アフィリエイトのご案内のみに利用します。
                詳しくは
                <button type="button" onClick={() => navigate("/privacy")} className="underline hover:text-primary mx-0.5">
                  プライバシーポリシー
                </button>
                をご確認ください。
              </p>
            </form>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
