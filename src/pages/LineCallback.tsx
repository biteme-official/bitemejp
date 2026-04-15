import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { handleLineCallback } from '@/lib/line-auth';
import { useAuthStore } from '@/stores/authStore';
import { Loader2, CheckCircle2 } from 'lucide-react';

export default function LineCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ displayName: string } | null>(null);

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
        login({
          userId: profile.userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          email: profile.email,
          shopifyCustomerToken: (profile as any).shopifyCustomerToken,
          shopifyEmail: (profile as any).shopifyEmail,
        });

        setSuccess({ displayName: profile.displayName });

        // Redirect to the page user was on before login
        const returnTo = localStorage.getItem('line_login_return_to') || '/';
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
