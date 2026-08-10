import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { handleLineCallback, submitCustomerEmail } from '@/lib/line-auth';
import { LINE_WELCOME_DISCOUNT_CODE, LINE_WELCOME_DISCOUNT_KEY } from '@/lib/lineWelcomeDiscount';
import { useAuthStore } from '@/stores/authStore';
import { Loader2, CheckCircle2, Mail } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function LineCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const updateEmail = useAuthStore((state) => state.updateEmail);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ displayName: string } | null>(null);

  // LINE이 이메일을 주지 않은 경우에만 입력 단계를 노출한다.
  // 자리표시자 이메일(@line-user.biteme.co.jp)은 MX 레코드가 없어
  // 주문 확인·배송 메일이 전량 바운스되기 때문.
  const [emailStep, setEmailStep] = useState<{
    token: string | null;
    sessionToken?: string;
    displayName: string;
  } | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // LINE 앱을 거쳐 오면 브라우저 컨텍스트가 바뀌어 localStorage 가 비어 있을 수 있다.
  // 그 경우 서버가 서명된 state 에서 복원해준 경로를 쓴다.
  const [serverReturnTo, setServerReturnTo] = useState<string>('/');

  function goBack() {
    const returnTo = localStorage.getItem('line_login_return_to') || serverReturnTo;
    localStorage.removeItem('line_login_return_to');
    navigate(returnTo, { replace: true });
  }

  function finishWithGreeting(displayName: string) {
    setSuccess({ displayName });
    setTimeout(goBack, 2000);
  }

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const errorParam = searchParams.get('error');

    if (errorParam) {
      setError('LINEログインがキャンセルされました。');
      setTimeout(() => navigate('/'), 3000);
      return;
    }

    if (!code || !state) {
      setError('無効なコールバックです。');
      setTimeout(() => navigate('/'), 3000);
      return;
    }

    handleLineCallback(code, state)
      .then((profile) => {
        if (profile.returnTo) setServerReturnTo(profile.returnTo);

        login({
          userId: profile.userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          email: profile.email,
          shopifyCustomerToken: profile.shopifyCustomerToken,
          shopifyEmail: profile.shopifyEmail,
          shopifyCustomerId: profile.shopifyCustomerId,
          lineSessionToken: profile.lineSessionToken,
        });

        // 로그인 보상 쿠폰을 예약해둔다. 체크아웃 생성 시 자동으로 붙는다
        // (cartStore). 1인 1회 제한은 Shopify 가 강제하므로 여기서 소진 여부를
        // 따로 추적하지 않는다.
        try {
          localStorage.setItem(LINE_WELCOME_DISCOUNT_KEY, LINE_WELCOME_DISCOUNT_CODE);
        } catch { /* 저장 실패해도 로그인은 계속된다 */ }

        // 인증 수단이 하나라도 있으면 이메일을 등록할 수 있다.
        // Storefront 토큰이 발급되지 않는 계정(초기 가입자 일부)은 세션 토큰으로 처리된다.
        if (profile.needsEmail && (profile.shopifyCustomerToken || profile.lineSessionToken)) {
          setEmailStep({
            token: profile.shopifyCustomerToken ?? null,
            sessionToken: profile.lineSessionToken,
            displayName: profile.displayName,
          });
          return;
        }

        setSuccess({ displayName: profile.displayName });

        // Redirect to the page user was on before login
        const returnTo =
          localStorage.getItem('line_login_return_to') || profile.returnTo || '/';
        localStorage.removeItem('line_login_return_to');

        setTimeout(() => {
          navigate(returnTo, { replace: true });
        }, 2000);
      })
      .catch((err) => {
        console.error('LINE login error:', err);
        setError(err.message || 'ログインに失敗しました。');
        setTimeout(() => navigate('/'), 3000);
      });
  }, [searchParams, navigate, login]);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailStep || submitting) return;

    setEmailError(null);
    setSubmitting(true);
    try {
      const result = await submitCustomerEmail(emailStep.token, emailInput, emailStep.sessionToken);
      updateEmail(result.email, result.customerAccessToken);
      finishWithGreeting(emailStep.displayName);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'メールアドレスの登録に失敗しました。');
    } finally {
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center p-8">
          <p className="text-destructive text-lg mb-2">{error}</p>
          <p className="text-muted-foreground text-sm">トップページに戻ります...</p>
        </div>
      </div>
    );
  }

  if (emailStep) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <form onSubmit={handleEmailSubmit} className="w-full max-w-sm space-y-5">
          <div className="text-center space-y-3">
            <Mail className="h-10 w-10 text-primary mx-auto" />
            <h1 className="text-lg font-bold text-foreground">メールアドレスのご登録</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {emailStep.displayName}さん、ようこそ！
              <br />
              ご注文確認・配送のお知らせをお送りするため、
              <br />
              メールアドレスをご登録ください。
            </p>
          </div>

          <div className="space-y-2">
            <Input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              required
              placeholder="example@email.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              disabled={submitting}
              aria-invalid={emailError ? true : undefined}
            />
            {emailError && <p className="text-sm text-destructive">{emailError}</p>}
          </div>

          <div className="space-y-3">
            <Button type="submit" className="w-full" disabled={submitting || !emailInput.trim()}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : '登録する'}
            </Button>
            <button
              type="button"
              onClick={() => finishWithGreeting(emailStep.displayName)}
              disabled={submitting}
              className="w-full text-sm text-muted-foreground underline underline-offset-4 disabled:opacity-50"
            >
              あとで登録する
            </button>
          </div>

          <p className="text-xs text-muted-foreground text-center leading-relaxed">
            ご登録いただいたメールアドレスは、
            <br />
            プライバシーポリシーに従って取り扱います。
          </p>
        </form>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center p-8 space-y-4">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
          <p className="text-foreground text-lg font-semibold">
            ログインに成功しました
          </p>
          <p className="text-muted-foreground text-sm">
            {success.displayName}さん、ようこそ！
          </p>
          <p className="text-muted-foreground text-xs">
            元のページに戻ります...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center p-8">
        <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
        <p className="text-foreground text-lg">ログイン処理中...</p>
      </div>
    </div>
  );
}
