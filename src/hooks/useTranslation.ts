import { useCallback } from 'react';
import { Language, t as translate } from '@/lib/i18n';

export function useTranslation() {
  const language: Language = 'ja';
  const locale = 'ja-JP';

  const t = useCallback((path: string): string => {
    return translate(path);
  }, []);

  const formatDate = useCallback((dateString: string, options?: Intl.DateTimeFormatOptions): string => {
    const defaultOptions: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    };
    return new Date(dateString).toLocaleDateString(locale, options || defaultOptions);
  }, []);

  const formatPrice = useCallback((amount: number | string, currency: string = 'JPY'): string => {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
    }).format(numAmount);
  }, []);

  return {
    t,
    language,
    locale,
    formatDate,
    formatPrice,
  };
}
