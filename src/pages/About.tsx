import { useNavigate } from "react-router-dom";
import { ChevronLeft, MapPin, Phone, Mail, Clock } from "lucide-react";
import { Footer } from "@/components/layout/Footer";
import biteMeLogo from "@/assets/bite-me-logo.png";

export default function About() {
  const navigate = useNavigate();

  return (
    <div className="bg-background min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 bg-background border-b border-border">
        <div className="flex items-center gap-2 px-4 h-14">
          <button onClick={() => navigate(-1)} className="p-1 text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button onClick={() => navigate("/")} className="hover:opacity-80 transition-opacity">
            <img src={biteMeLogo} alt="BITE ME" className="h-[17px]" />
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 flex-1 space-y-10">
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">BITE ME JAPANについて</h1>
          <p className="text-muted-foreground leading-relaxed">
            BITE ME JAPANは、大切なペットのために厳選されたペット用品をお届けするオンラインショップです。
            安心・安全な商品を日本全国へお届けします。
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold">会社情報</h2>
          <div className="bg-card border border-border rounded-xl divide-y divide-border">
            <div className="flex gap-3 px-4 py-3">
              <span className="text-sm text-muted-foreground w-28 shrink-0">運営会社</span>
              <span className="text-sm">株式会社インケア</span>
            </div>
            <div className="flex gap-3 px-4 py-3">
              <span className="text-sm text-muted-foreground w-28 shrink-0">代表者</span>
              <span className="text-sm">植森 あさみ</span>
            </div>
            <div className="flex gap-3 px-4 py-3 items-start">
              <span className="text-sm text-muted-foreground w-28 shrink-0 flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />所在地
              </span>
              <span className="text-sm">〒170-0005<br />東京都豊島区南大塚2-38-1</span>
            </div>
            <div className="flex gap-3 px-4 py-3 items-center">
              <span className="text-sm text-muted-foreground w-28 shrink-0 flex items-center gap-1">
                <Phone className="h-3.5 w-3.5" />電話番号
              </span>
              <a href="tel:0368683009" className="text-sm hover:text-primary transition-colors">
                03-6868-3009
              </a>
            </div>
            <div className="flex gap-3 px-4 py-3 items-center">
              <span className="text-sm text-muted-foreground w-28 shrink-0 flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" />メール
              </span>
              <a href="mailto:japan@biteme.co.kr" className="text-sm hover:text-primary transition-colors">
                japan@biteme.co.kr
              </a>
            </div>
            <div className="flex gap-3 px-4 py-3 items-center">
              <span className="text-sm text-muted-foreground w-28 shrink-0 flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />サポート時間
              </span>
              <span className="text-sm">平日 10:00〜18:00</span>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold">ショッピングガイド</h2>
          <div className="grid grid-cols-1 gap-3">
            {[
              { title: "ご注文", desc: "商品をカートに入れ、LINEログインでご購入いただけます。" },
              { title: "お支払い", desc: "クレジットカード決済に対応しています。" },
              { title: "配送", desc: "ご注文確定後、2〜3営業日以内に発送いたします。" },
              { title: "返品・交換", desc: "商品に欠陥がある場合に限り対応いたします。" },
            ].map((item) => (
              <div key={item.title} className="bg-card border border-border rounded-xl px-4 py-3">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-sm text-muted-foreground mt-1">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
