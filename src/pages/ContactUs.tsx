import { useNavigate } from "react-router-dom";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Phone, Mail, MessageCircle } from "lucide-react";

const ContactUs = () => {
  const navigate = useNavigate();

  const handleSearch = (query: string) => {
    navigate(query ? `/?q=${encodeURIComponent(query)}` : '/');
  };

  return (
    <div className="bg-background min-h-screen flex flex-col">
      <Header onSearch={handleSearch} />

      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="text-center space-y-8">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            Customer Service
          </h1>

          <div className="space-y-4 text-lg text-muted-foreground">
            <div className="flex items-center justify-center gap-2">
              <Phone className="h-5 w-5 text-primary" />
              <span>Support Phone Number:</span>
              <a
                href="tel:0368683009"
                className="text-foreground hover:text-primary transition-colors font-medium"
              >
                03-6868-3009
              </a>
            </div>

            <div className="flex items-center justify-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              <span>Support E-mail:</span>
              <a
                href="mailto:japan@biteme.co.kr"
                className="text-foreground hover:text-primary transition-colors font-medium"
              >
                japan@biteme.co.kr
              </a>
            </div>

            {/*
              LINE 1:1 상담. 플로팅 버튼이 비로그인 상태에서는 로그인 유도로 쓰이므로
              LINE 문의 진입점을 여기서 항상 보장한다.
            */}
            <div className="flex items-center justify-center gap-2">
              <MessageCircle className="h-5 w-5 text-primary" />
              <span>LINE:</span>
              <a
                href="https://line.me/R/ti/p/@621txosw"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground hover:text-primary transition-colors font-medium"
              >
                LINEで問い合わせる
              </a>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default ContactUs;
