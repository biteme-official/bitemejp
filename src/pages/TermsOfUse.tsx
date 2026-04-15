import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Footer } from "@/components/layout/Footer";
import biteMeLogo from "@/assets/bite-me-logo.png";

export default function TermsOfUse() {
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
        <h1 className="text-2xl font-bold mb-6">利用規約</h1>
        <div className="prose prose-sm max-w-none text-muted-foreground space-y-6">

          <p className="text-sm text-muted-foreground">最終更新日：2026年3月18日</p>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第1条（適用）</h2>
            <p>
              本利用規約（以下「本規約」）は、BITE ME JAPAN（以下「当社」）が提供する
              オンラインショッピングサービス（以下「本サービス」）の利用条件を定めるものです。
              お客様は、本サービスを利用することにより、本規約に同意したものとみなされます。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第2条（会員登録）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>本サービスの一部機能を利用するためには、会員登録が必要です。</li>
              <li>会員登録は、LINEアカウントを利用したログインにより行うことができます。</li>
              <li>お客様は、登録情報に変更があった場合、速やかに当社に通知するものとします。</li>
              <li>当社は、以下の場合に会員登録を拒否または取り消すことがあります。
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  <li>虚偽の情報を提供した場合</li>
                  <li>本規約に違反した場合</li>
                  <li>その他、当社が不適切と判断した場合</li>
                </ul>
              </li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第3条（LINEアカウント連携）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>お客様は、LINEアカウントを本サービスと連携することで、会員特典を受けることができます。</li>
              <li>LINE連携により、当社はLINEプロフィール情報（表示名、プロフィール画像、メールアドレス等）を取得します。</li>
              <li>取得した情報の取り扱いについては、当社のプライバシーポリシーに従います。</li>
              <li>お客様はいつでもLINE連携を解除することができます。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第4条（商品の購入）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>お客様は、本サービス上で商品を選択し、所定の手続きにより購入することができます。</li>
              <li>売買契約は、当社がお客様の注文を確認し、注文確認メールを送信した時点で成立します。</li>
              <li>商品の価格は、本サービス上に表示された金額とし、消費税を含みます。</li>
              <li>配送料は、注文内容および配送先により異なり、注文確認時に表示されます。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第5条（お支払い）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>お支払い方法は、クレジットカード、その他当社が認める決済手段とします。</li>
              <li>お支払いに関する処理は、Shopifyの決済システムを通じて行われます。</li>
              <li>決済に関するトラブルについては、各決済事業者の規約に従います。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第6条（配送）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>商品の配送は、日本国内に限ります。</li>
              <li>配送日数は、注文確認後、通常3〜7営業日を目安としますが、在庫状況や配送事情により遅延する場合があります。</li>
              <li>配送中の商品の紛失・破損については、当社が責任を持って対応いたします。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第7条（返品・交換）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>商品到着後7日以内に、未使用・未開封の状態であれば、返品・交換を承ります。</li>
              <li>お客様都合による返品の場合、返送料はお客様の負担とします。</li>
              <li>不良品・誤配送の場合は、当社負担で交換・返金いたします。</li>
              <li>返品・交換をご希望の場合は、事前にお問い合わせください。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第8条（会員特典・割引）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>LINE連携会員は、当社が提供する会員限定の割引やキャンペーンに参加することができます。</li>
              <li>特典の内容は、当社の裁量により変更・終了する場合があります。</li>
              <li>特典の不正利用が確認された場合、当社は特典の取消しおよびアカウントの停止を行うことがあります。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第9条（禁止事項）</h2>
            <p>お客様は、本サービスの利用にあたり、以下の行為を行ってはなりません。</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>法令または公序良俗に反する行為</li>
              <li>当社または第三者の権利を侵害する行為</li>
              <li>不正アクセスやシステムに過度な負荷をかける行為</li>
              <li>虚偽の情報を登録する行為</li>
              <li>転売目的での大量購入</li>
              <li>その他、当社が不適切と判断する行為</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第10条（知的財産権）</h2>
            <p>
              本サービスに掲載されているすべてのコンテンツ（画像、テキスト、ロゴ、デザイン等）の
              知的財産権は、当社または正当な権利者に帰属します。
              当社の事前の書面による許可なく、複製、転載、転用することを禁じます。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第11条（免責事項）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>当社は、本サービスの内容の正確性、完全性、有用性について保証いたしません。</li>
              <li>システム障害、メンテナンス等によるサービスの一時的な停止について、当社は責任を負いません。</li>
              <li>お客様間またはお客様と第三者間のトラブルについて、当社は一切の責任を負いません。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第12条（規約の変更）</h2>
            <p>
              当社は、必要に応じて本規約を変更することがあります。
              変更後の規約は、本サービス上に掲載された時点で効力を生じるものとします。
              重要な変更がある場合は、適切な方法でお知らせいたします。
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第13条（準拠法・管轄裁判所）</h2>
            <ol className="list-decimal pl-5 space-y-2">
              <li>本規約の解釈は、日本法に準拠するものとします。</li>
              <li>本サービスに関する紛争については、東京地方裁判所を第一審の専属的合意管轄裁判所とします。</li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mt-6 mb-3">第14条（お問い合わせ）</h2>
            <p>本規約に関するお問い合わせは、以下までご連絡ください。</p>
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
