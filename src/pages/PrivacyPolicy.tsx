import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Footer } from "@/components/layout/Footer";
import biteMeLogo from "@/assets/bite-me-logo.png";

export default function PrivacyPolicy() {
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

      <main className="max-w-2xl mx-auto px-4 py-8 flex-1">
        <h1 className="text-2xl font-bold mb-6">プライバシーポリシー</h1>
        <div className="prose prose-sm max-w-none text-muted-foreground space-y-6">

          <p className="text-sm text-muted-foreground">最終更新日：2026年3月18日</p>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">1. はじめに</h2>
            <p>
              BITE ME JAPAN（以下「当社」）は、お客様の個人情報の保護を重要視しております。
              本プライバシーポリシーは、当社が運営するウェブサイト（以下「本サービス」）における
              個人情報の取り扱いについて定めるものです。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">2. 収集する情報</h2>
            <p>当社は、以下の情報を収集することがあります。</p>
            <h3 className="text-base font-medium text-foreground mt-4 mb-2">2.1 お客様から直接提供される情報</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>氏名</li>
              <li>メールアドレス</li>
              <li>住所（配送先情報）</li>
              <li>電話番号</li>
              <li>お支払い情報</li>
            </ul>
            <h3 className="text-base font-medium text-foreground mt-4 mb-2">2.2 LINEログインを通じて取得する情報</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>LINEユーザーID</li>
              <li>表示名</li>
              <li>プロフィール画像</li>
              <li>メールアドレス（ご同意いただいた場合）</li>
            </ul>
            <h3 className="text-base font-medium text-foreground mt-4 mb-2">2.3 自動的に収集される情報</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>IPアドレス</li>
              <li>ブラウザの種類</li>
              <li>アクセス日時</li>
              <li>閲覧ページ</li>
              <li>Cookie情報</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">3. 情報の利用目的</h2>
            <p>収集した情報は、以下の目的で利用いたします。</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>商品の販売および配送</li>
              <li>お客様アカウントの管理</li>
              <li>カスタマーサポートの提供</li>
              <li>新商品やキャンペーン情報のご案内（ご同意いただいた場合）</li>
              <li>サービスの改善および分析</li>
              <li>会員限定特典・割引の提供</li>
              <li>不正利用の防止</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">4. 情報の共有・第三者提供</h2>
            <p>当社は、以下の場合を除き、お客様の個人情報を第三者に提供いたしません。</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>お客様の同意がある場合</li>
              <li>配送業者への配送情報の提供</li>
              <li>決済処理業者への支払い情報の提供</li>
              <li>法令に基づく場合</li>
              <li>当社のサービス運営に必要な業務委託先への提供（Shopify、LINE等）</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">5. Cookieの使用</h2>
            <p>
              当社は、サービスの利便性向上およびアクセス分析のためにCookieを使用しています。
              お客様はブラウザの設定によりCookieの受け入れを拒否することができますが、
              一部のサービスが正常に動作しない場合があります。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">6. データの安全管理</h2>
            <p>
              当社は、個人情報の漏洩、紛失、改ざんを防止するため、適切なセキュリティ対策を講じています。
              SSL暗号化通信の使用、アクセス制限の実施等により、お客様の情報を保護いたします。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">7. お客様の権利</h2>
            <p>お客様は、以下の権利を有しています。</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>個人情報の開示・訂正・削除の請求</li>
              <li>個人情報の利用停止の請求</li>
              <li>マーケティング目的の利用に対するオプトアウト</li>
            </ul>
            <p className="mt-2">これらの請求については、下記のお問い合わせ先までご連絡ください。</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">8. 未成年者の個人情報</h2>
            <p>
              当社は、16歳未満のお客様から意図的に個人情報を収集いたしません。
              16歳未満の方が個人情報を提供された場合は、保護者の方からご連絡いただければ、
              速やかに削除いたします。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">9. プライバシーポリシーの変更</h2>
            <p>
              当社は、必要に応じて本プライバシーポリシーを変更することがあります。
              重要な変更がある場合は、本サービス上でお知らせいたします。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">10. お問い合わせ</h2>
            <p>個人情報の取り扱いに関するお問い合わせは、以下までご連絡ください。</p>
            <div className="mt-2 p-4 bg-secondary rounded-lg">
              <p className="font-medium text-foreground">BITE ME JAPAN</p>
              <p>メール：support@biteme-jp.com</p>
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
