import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/bitemejp[a-z0-9-]*\.vercel\.app$/.test(origin)) return true;
  return false;
}

function getCorsOrigin(req: VercelRequest): string {
  const origin = req.headers.origin || '';
  return isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
}

// Shopify가 sunset 예정 API 버전에 대해 응답 헤더로 경고를 보냄.
// 감지 즉시 Slack으로 알림을 보내 다음 장애를 사전에 방지한다.
async function notifyDeprecation(version: string, header: string) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `⚠️ *Shopify API Deprecation 감지*\n현재 사용 버전: \`${version}\`\nShopify 경고: ${header}\n\n지금 바로 staging에서 최신 버전으로 업그레이드 테스트를 시작하세요.`,
    }),
  }).catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOrigin = getCorsOrigin(req);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.SHOPIFY_STOREFRONT_TOKEN?.trim();
  const shop = process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
  // 환경변수로 API 버전을 제어 — staging: 2026-04, production: 2025-10
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-04';

  console.log(`[Shopify Proxy] shop=${shop} version=${apiVersion} token_len=${token?.length ?? 0} token_suffix=${token ? token.slice(-6) : 'MISSING'}`);

  if (!token) {
    console.error('[Shopify Proxy] Missing SHOPIFY_STOREFRONT_TOKEN');
    return res.status(500).json({ error: 'Missing token configuration' });
  }

  try {
    const shopifyResponse = await fetch(
      `https://${shop}/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Shopify-Storefront-Private-Token': token,
        },
        body: JSON.stringify(req.body),
      }
    );

    // Shopify sunset 경고 헤더 감지
    const deprecationHeader = shopifyResponse.headers.get('X-Shopify-API-Deprecated');
    if (deprecationHeader) {
      console.warn(`[Shopify] API ${apiVersion} deprecation warning:`, deprecationHeader);
      notifyDeprecation(apiVersion, deprecationHeader);
    }

    const data = await shopifyResponse.text();
    if (!shopifyResponse.ok) {
      const hdrs: Record<string, string> = {};
      shopifyResponse.headers.forEach((v, k) => { hdrs[k] = v; });
      console.error(`[Shopify] ${shopifyResponse.status} (${apiVersion}):`, data.substring(0, 200));
      console.error(`[Shopify] response headers:`, JSON.stringify(hdrs));
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    return res.status(shopifyResponse.status).send(data);
  } catch (error) {
    console.error('[Shopify Proxy] Error:', error);
    return res.status(500).json({ error: String(error) });
  }
}
