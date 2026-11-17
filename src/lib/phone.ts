/**
 * 결제 폼 전화번호 → Shopify 결제 화면에 넘길 값으로 정리한다 (#310).
 *
 * Shopify 결제 화면은 국가가 일본이면 받은 번호 앞에 +81 을 붙인다.
 * `819012345678` 처럼 + 없이 81 로 시작하는 번호를 그대로 넘기면 `+81 819012345678` 이 되어
 * 「Enter a valid phone number」 로 결제가 막힌다. 그래서 넘기기 전에 일본 번호는 +81 형식으로 바꾼다.
 *
 * 일본 국내 번호(0 으로 시작)는 81 로 시작할 수 없으므로, 81 로 시작하면 국가번호가 붙은 것으로 본다.
 */
export interface NormalizedPhone {
  /** Shopify 에 넘길 값. 빈 입력이면 '' */
  value: string;
  /** 일본 번호로 자릿수가 맞는지. 빈 입력·해외 번호는 true (판단하지 않음) */
  valid: boolean;
}

export function normalizeJpPhone(raw: string): NormalizedPhone {
  // 전각 숫자·＋ → 반각, 하이픈·공백·괄호·점 제거
  const s = (raw || '').normalize('NFKC').replace(/[\s\-‐‑‒–—―ー－().]/g, '');
  if (!s) return { value: '', valid: true };

  let national: string | null = null;
  if (s.startsWith('+81')) national = s.slice(3);
  else if (s.startsWith('0081')) national = s.slice(4);
  else if (s.startsWith('+')) return { value: s, valid: /^\+\d{6,15}$/.test(s) }; // 해외 번호는 그대로
  else if (s.startsWith('81')) national = s.slice(2);
  else if (s.startsWith('0')) national = s.slice(1);
  else national = s; // 맨 앞 0 을 빠뜨린 경우 (9012345678)

  national = national.replace(/^0/, ''); // +81 090… 처럼 0 을 같이 쓴 경우
  if (!/^\d+$/.test(national)) return { value: raw.trim(), valid: false };

  // 일본 번호는 0 을 뺀 뒤 9자리(유선) 또는 10자리. 휴대전화(070·080·090)·IP(050)는 반드시 10자리
  const valid = /^[5789]0/.test(national) ? national.length === 10 : national.length === 9 || national.length === 10;
  return { value: valid ? `+81${national}` : raw.trim(), valid };
}
