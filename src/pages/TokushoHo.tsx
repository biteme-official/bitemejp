import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Footer } from "@/components/layout/Footer";
import biteMeLogo from "@/assets/bite-me-logo.png";

export default function TokushoHo() {
  const navigate = useNavigate();
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/policies')
      .then((res) => res.json())
      .then((data) => setBody(data?.policy?.body ?? null))
      .catch(() => setBody(null))
      .finally(() => setLoading(false));
  }, []);

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
        <h1 className="text-2xl font-bold mb-6">特定商取引法に基づく表記</h1>

        {loading && (
          <div className="space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-4 bg-muted rounded animate-pulse" style={{ width: `${75 + (i % 3) * 10}%` }} />
            ))}
          </div>
        )}

        {!loading && body && (
          <div
            className="prose prose-sm max-w-none text-muted-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-6 [&_h2]:mb-3 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-foreground [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1 [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: body }}
          />
        )}

        {!loading && !body && (
          <div className="text-muted-foreground text-sm">
            <p>現在、特定商取引法に基づく表記を準備中です。</p>
            <p className="mt-2">お問い合わせは下記までご連絡ください。</p>
            <div className="mt-4 p-4 bg-secondary rounded-lg">
              <p className="font-medium text-foreground">BITE ME JAPAN</p>
              <p>メール：japan@biteme.co.kr</p>
              <p>電話：03-6868-3009</p>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
