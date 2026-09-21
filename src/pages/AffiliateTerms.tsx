/**
 * /affiliate/terms — アフィリエイトプログラム利用規約 + 別紙 広告表示ガイドライン (#178 Phase 2)
 * 본문은 src/data/affiliate-terms.ts. 가입 화면·파트너 페이지에서 링크한다.
 */
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Footer } from "@/components/layout/Footer";
import biteMeLogo from "@/assets/bite-me-logo.png";
import { AD_DISCLOSURE_GUIDE, AFFILIATE_TERMS, AFFILIATE_TERMS_ENACTED, AFFILIATE_TERMS_VERSION } from "@/data/affiliate-terms";

export default function AffiliateTerms() {
  const navigate = useNavigate();

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

      <main className="max-w-2xl mx-auto px-4 py-8 flex-1">
        <h1 className="text-2xl font-bold mb-2">アフィリエイトプログラム利用規約</h1>
        <p className="text-sm text-muted-foreground mb-6">
          制定：{AFFILIATE_TERMS_ENACTED}（版 {AFFILIATE_TERMS_VERSION}）
        </p>

        <div className="text-sm text-muted-foreground space-y-8 leading-relaxed">
          {AFFILIATE_TERMS.map((art) => (
            <section key={art.title} id={art.title.slice(0, art.title.indexOf('条') + 1)}>
              <h2 className="text-base font-semibold text-foreground mb-3">{art.title}</h2>
              {art.lead && <p className="mb-2">{art.lead}</p>}
              <ol className="list-decimal pl-5 space-y-2">
                {art.items.map((item, i) =>
                  typeof item === "string" ? (
                    <li key={i}>{item}</li>
                  ) : (
                    <li key={i}>
                      {item.text}
                      <ul className="list-disc pl-5 mt-1.5 space-y-1">
                        {item.sub.map((s, j) => <li key={j}>{s}</li>)}
                      </ul>
                    </li>
                  )
                )}
              </ol>
            </section>
          ))}
          <p>以上</p>

          <section id="guideline" className="border-t border-border pt-8">
            <h2 className="text-base font-semibold text-foreground mb-2">{"別紙　広告表示ガイドライン"}</h2>
            <p className="mb-4">{AD_DISCLOSURE_GUIDE.lead}</p>
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full text-xs border-collapse min-w-[520px]">
                <thead>
                  <tr className="border-b border-border text-left text-foreground">
                    <th className="py-2 pr-3 font-medium">媒体</th>
                    <th className="py-2 pr-3 font-medium">表示の位置</th>
                    <th className="py-2 font-medium">表示の例</th>
                  </tr>
                </thead>
                <tbody>
                  {AD_DISCLOSURE_GUIDE.rows.map((r) => (
                    <tr key={r.media} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-3 text-foreground">{r.media}</td>
                      <td className="py-2 pr-3">{r.where}</td>
                      <td className="py-2">{r.example}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="text-sm font-semibold text-foreground mt-6 mb-2">認めない例</h3>
            <ul className="list-disc pl-5 space-y-1">
              {AD_DISCLOSURE_GUIDE.ng.map((s) => <li key={s}>{s}</li>)}
            </ul>
            <p className="mt-4 rounded-lg bg-muted px-4 py-3 text-foreground">{AD_DISCLOSURE_GUIDE.rule}</p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
