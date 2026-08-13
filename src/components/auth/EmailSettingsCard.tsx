/**
 * 마이페이지의 이메일 등록·변경 카드.
 *
 * LINE 이 이메일을 주지 않은 유저는 자리표시자 이메일로 고객이 만들어지는데,
 * 그 도메인은 MX 레코드가 없어 주문 확인·발송 알림이 전량 바운스된다.
 * 등록 화면이 로그인 직후 한 번뿐이라 오타를 쳐도 스스로 고칠 수 없었다 (Issue #122).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/authStore';
import { submitCustomerEmail, isPlaceholderEmail, EmailUpdateError } from '@/lib/line-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function EmailSettingsCard() {
  const navigate = useNavigate();
  const { user, updateEmail } = useAuthStore();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);

  if (!user) return null;

  // ⚠️ user.email 은 LINE 이 준 주소라 이메일 미동의 유저는 아예 비어 있다.
  //    실제로 메일이 나가는 곳은 Shopify 고객의 주소(shopifyEmail) 이므로
  //    등록 여부는 반드시 이쪽으로 판단해야 한다.
  const contactEmail = user.shopifyEmail ?? user.email ?? '';
  const unregistered = !contactEmail || isPlaceholderEmail(contactEmail);
  // 서버가 인정하는 인증 수단. 둘 다 없으면 변경 요청이 401 로 막힌다.
  const canEdit = !!(user.shopifyCustomerToken || user.lineSessionToken);

  function startEditing() {
    setValue(unregistered ? '' : contactEmail);
    setError(null);
    setEditing(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setError(null);
    setSubmitting(true);
    try {
      const result = await submitCustomerEmail(
        user!.shopifyCustomerToken,
        value,
        user!.lineSessionToken
      );
      updateEmail(result.email, result.customerAccessToken);
      setEditing(false);
      // 무변경도 반드시 알린다 — 아무 말 없이 폼이 닫히면 조용히 실패한 것과 구별되지 않는다.
      if (result.unchanged) {
        toast('現在のメールアドレスと同じです');
      } else {
        toast.success(unregistered ? 'メールアドレスを登録しました' : 'メールアドレスを変更しました');
      }
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'メールアドレスの登録に失敗しました。',
        code: err instanceof EmailUpdateError ? err.code : null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border p-5">
      <div className="flex items-center gap-2 mb-3">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">メールアドレス</h3>
      </div>

      {editing ? (
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="example@biteme.co.jp"
            disabled={submitting}
            className="h-11"
          />
          <p className="text-xs text-muted-foreground">
            ご注文確認・発送のお知らせをこのアドレスにお送りします。
          </p>

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 space-y-1.5">
              <p className="text-xs text-destructive">{error.message}</p>
              {/* 계정 병합은 API 로 불가하므로 문의로 이어준다 */}
              {error.code === 'EMAIL_TAKEN' && (
                <p className="text-xs text-muted-foreground">
                  以前ゲストとしてご注文された際のアドレスの可能性があります。
                  <button
                    type="button"
                    onClick={() => navigate('/contact')}
                    className="ml-1 text-primary underline underline-offset-2"
                  >
                    お問い合わせ
                  </button>
                  よりご連絡ください。
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button type="submit" className="flex-1 h-11" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              保存する
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setEditing(false)}
              disabled={submitting}
            >
              キャンセル
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          {unregistered ? (
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">未登録</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  ご注文確認・発送のお知らせメールをお届けできません。
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm break-all">{contactEmail}</p>
          )}

          {canEdit ? (
            <Button
              variant={unregistered ? 'default' : 'outline'}
              className="w-full h-11"
              onClick={startEditing}
            >
              {unregistered ? 'メールアドレスを登録' : '変更する'}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              変更するには、お手数ですが再度LINEでログインしてください。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
