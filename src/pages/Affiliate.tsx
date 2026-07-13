import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Instagram, Mail, Sparkles, BadgePercent, Users, PartyPopper, ChevronLeft, Loader2, CheckCircle2 } from "lucide-react";
import { Footer } from "@/components/layout/Footer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import biteMeLogo from "@/assets/bite-me-logo.png";

const BENEFITS = [
  {
    icon: BadgePercent,
    title: "成果報酬コミッション",
    desc: "専用アフィリエイトコードでご紹介いただいた売上に応じてコミッションを還元。オープン記念として特別料率でご案内します。",
  },
  {
    icon: Users,
    title: "コラボ企画",
    desc: "新商品の共同企画やイベントなど、継続的なコラボの機会をご提供します。",
  },
];

const STEPS = [
  "下のフォームからInstagramアカウントとメールアドレスをご登録ください。",
  "ご登録は受付順に承ります。担当者が順番に内容を確認いたします。",
  "審査通過後、ご登録のメール宛に招待をお送りします。順次ご案内するため、少々お時間をいただく場合があります。",
];

export default function Affiliate() {
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
              <PartyPopper className="h-3.5 w-3.5" />
              オープン記念キャンペーン
            </span>
            <div className="mt-3 flex items-end justify-center gap-1">
              <span className="text-6xl font-extrabold leading-none tracking-tight">10</span>
              <span className="text-3xl font-bold pb-1">%</span>
            </div>
            <p className="mt-2 text-sm font-medium">ご紹介いただいた売上のコミッション率</p>
            <p className="mt-2 text-xs text-primary-foreground/80 leading-relaxed">
              アフィリエイトプログラム開始を記念して、期間限定で特別コミッション率10%をご提供します。
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
          <h2 className="text-lg font-semibold text-center">ご招待までの流れ</h2>
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
          <p className="text-xs text-muted-foreground/70 text-center pt-2">
            ※ ご登録は受付順（先着順）に順次ご案内いたします。
          </p>
        </section>

        {/* 応募フォーム */}
        <section className="max-w-md mx-auto px-4 pb-16">
          {done ? (
            <div className="bg-card border border-border rounded-2xl px-6 py-10 text-center space-y-3">
              <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
              <h3 className="text-lg font-semibold">ご応募ありがとうございます</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                内容を確認のうえ、受付順にご登録のメール宛てご招待をお送りいたします。
                今しばらくお待ちください。
              </p>
              <Button variant="outline" className="mt-2" onClick={() => navigate("/")}>
                トップへ戻る
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl px-6 py-8 space-y-5">
              <div className="text-center space-y-1">
                <h3 className="text-lg font-semibold">応募する</h3>
                <p className="text-xs text-muted-foreground">
                  Instagramアカウントとメールアドレスをご登録ください。
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
                  "応募する"
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
