/**
 * /api/update-customer-email
 *
 * LINE 로그인 시 이메일 동의를 하지 않은 유저는 자리표시자 이메일
 * `line_{userId}@line-user.biteme.co.jp` 로 Shopify 고객이 생성된다.
 * 이 도메인은 MX 레코드가 없어 주문 확인·배송 메일이 전량 바운스되므로
 * (2026-08-07 실측: 주문에도 이 주소가 그대로 기록됨) 로그인 후 실제
 * 이메일을 받아 교체한다.
 *
 * 인증: customerAccessToken 을 Storefront API 로 검증해 본인만 변경 가능.
 *       자리표시자 이메일인 경우에만 허용한다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac } from 'crypto';

const SHOP = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
const SHOPIFY_API_VERSION = '2025-07';
const PLACEHOLDER_EMAIL_DOMAIN = '@line-user.biteme.co.jp';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/^https:\/\/smart-paw-finder[a-z0-9-]*\.vercel\.app$/.test(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

/** api/line-callback.ts 와 반드시 동일한 규칙 */
function generatePassword(lineUserId: string): string {
  const secret = process.env.SHOPIFY_CLIENT_SECRET || 'fallback-secret';
  return createHmac('sha256', secret).update(lineUserId).digest('hex').substring(0, 32);
}

/** 자리표시자 이메일에서 LINE userId 를 복원 (비밀번호 재생성용) */
function extractLineUserId(email: string): string | null {
  if (!email.endsWith(PLACEHOLDER_EMAIL_DOMAIN)) return null;
  const localPart = email.slice(0, -PLACEHOLDER_EMAIL_DOMAIN.length);
  if (!localPart.startsWith('line_')) return null;
  const userId = localPart.slice('line_'.length);
  return /^U[0-9a-f]{32}$/.test(userId) ? userId : null;
}

async function getStorefrontToken(): Promise<string> {
  const clientId = process.env.VITE_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing Shopify env vars');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Storefront token request failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function getAdminToken(): Promise<string> {
  const clientId = process.env.REPORT_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.REPORT_SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing Admin API env vars');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Admin token request failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function storefrontQuery(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Shopify-Storefront-Private-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function adminGraphQL(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// 서버측 최소 검증. 최종 유효성은 Shopify 가 판단한다.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const { customerAccessToken, email } = req.body || {};

  if (!customerAccessToken || typeof customerAccessToken !== 'string') {
    return res.status(400).json({ message: 'customerAccessToken is required' });
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ message: 'メールアドレスの形式が正しくありません。' });
  }

  const newEmail = email.trim().toLowerCase();

  if (newEmail.endsWith(PLACEHOLDER_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'メールアドレスの形式が正しくありません。' });
  }

  try {
    const sfToken = await getStorefrontToken();

    // 1. 토큰 검증 — 본인 계정만 변경할 수 있도록 서버에서 확인한다.
    //    클라이언트가 보낸 고객 ID 는 신뢰하지 않는다.
    const meResult = await storefrontQuery(sfToken, `
      query Me($token: String!) {
        customer(customerAccessToken: $token) { id email }
      }
    `, { token: customerAccessToken });

    const me = meResult?.data?.customer;
    if (!me?.id) {
      return res.status(401).json({ message: 'ログイン情報が無効です。もう一度ログインしてください。' });
    }

    // 2. 자리표시자 이메일일 때만 허용 (이미 실제 이메일이면 변경 대상 아님)
    const currentEmail: string = me.email ?? '';
    if (!currentEmail.endsWith(PLACEHOLDER_EMAIL_DOMAIN)) {
      return res.status(200).json({ email: currentEmail, alreadySet: true });
    }

    const lineUserId = extractLineUserId(currentEmail);
    if (!lineUserId) {
      console.error('[Update Email] 🔴 자리표시자 이메일에서 userId 추출 실패:', currentEmail);
      return res.status(500).json({ message: 'アカウント情報の確認に失敗しました。' });
    }

    // 3. Admin API 로 이메일 교체
    const adminToken = await getAdminToken();
    const updateResult = await adminGraphQL(adminToken, `
      mutation UpdateEmail($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id email }
          userErrors { field message }
        }
      }
    `, { input: { id: me.id, email: newEmail } });

    if (updateResult?.errors) {
      console.error(
        '[Update Email] 🔴 이메일 변경 실패 (GraphQL). write_customers 스코프를 확인하세요:',
        JSON.stringify(updateResult.errors)
      );
      return res.status(500).json({ message: 'メールアドレスの登録に失敗しました。' });
    }

    const userErrors: { field: string[] | null; message: string }[] =
      updateResult?.data?.customerUpdate?.userErrors ?? [];

    if (userErrors.length > 0) {
      const taken = userErrors.some((e) => /taken|已|すでに/i.test(e.message));
      console.error('[Update Email] 🔴 이메일 변경 userErrors:', JSON.stringify(userErrors));
      return res.status(taken ? 409 : 400).json({
        message: taken
          ? 'このメールアドレスは既に別のアカウントで使用されています。'
          : 'メールアドレスの登録に失敗しました。',
      });
    }

    const updatedEmail: string = updateResult?.data?.customerUpdate?.customer?.email ?? newEmail;

    // 4. 이메일이 바뀌면 기존 customerAccessToken 이 무효화될 수 있으므로 재발급한다.
    //    비밀번호는 LINE userId 기반 결정론적 생성이라 그대로 유효하다.
    let refreshedToken: string | null = null;
    try {
      const tokenResult = await storefrontQuery(sfToken, `
        mutation Refresh($input: CustomerAccessTokenCreateInput!) {
          customerAccessTokenCreate(input: $input) {
            customerAccessToken { accessToken }
            customerUserErrors { code message }
          }
        }
      `, { input: { email: updatedEmail, password: generatePassword(lineUserId) } });

      refreshedToken =
        tokenResult?.data?.customerAccessTokenCreate?.customerAccessToken?.accessToken ?? null;
      if (!refreshedToken) {
        console.error(
          '[Update Email] 토큰 재발급 실패:',
          JSON.stringify(tokenResult?.data?.customerAccessTokenCreate?.customerUserErrors)
        );
      }
    } catch (err) {
      console.error('[Update Email] 토큰 재발급 중 예외:', err);
    }

    console.log('[Update Email] 이메일 등록 완료:', me.id);

    return res.status(200).json({
      email: updatedEmail,
      customerAccessToken: refreshedToken,
    });
  } catch (error) {
    console.error('[Update Email] 🔴', error);
    return res.status(500).json({ message: 'メールアドレスの登録に失敗しました。' });
  }
}
