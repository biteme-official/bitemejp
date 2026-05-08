import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSign } from 'crypto';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || '';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  })).toString('base64url');

  const input = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(input);
  const jwt = `${input}.${sign.sign(sa.private_key, 'base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) throw new Error(`Token error: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken!;
}

async function runReport(token: string, body: object) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`GA4 error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

interface GA4Report {
  dimensionHeaders: { name: string }[];
  metricHeaders: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
}

function parseRows(report: GA4Report): Record<string, string | number>[] {
  return (report.rows || []).map((row) => {
    const out: Record<string, string | number> = {};
    row.dimensionValues?.forEach((v, i) => { out[report.dimensionHeaders[i].name] = v.value; });
    row.metricValues?.forEach((v, i) => { out[report.metricHeaders[i].name] = parseFloat(v.value) || 0; });
    return out;
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!ADMIN_SECRET || auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const range = (req.query.range as string) || '7d';
  const fromParam = req.query.from as string | undefined;
  const toParam = req.query.to as string | undefined;

  let dateRange: { startDate: string; endDate: string };
  if (range === 'custom' && fromParam && toParam) {
    dateRange = { startDate: fromParam, endDate: toParam };
  } else {
    const rangeMap: Record<string, string> = {
      today: 'today',
      '7d': '7daysAgo',
      '28d': '28daysAgo',
      '90d': '90daysAgo',
    };
    const startDate = rangeMap[range];
    if (!startDate) return res.status(400).json({ error: 'Invalid range' });
    dateRange = { startDate, endDate: 'today' };
  }

  if (!GA4_PROPERTY_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.status(500).json({ error: 'GA4 not configured. Set GA4_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_JSON env vars.' });
  }

  try {
    const token = await getAccessToken();

    const [overviewRaw, funnelRaw, revenueRaw, pagesRaw, sourcesRaw, devicesRaw, itemViewsRaw, exitPagesRaw, sourcesByDateRaw] = await Promise.all([
      runReport(token, {
        dateRanges: [dateRange],
        metrics: [
          { name: 'sessions' },
          { name: 'activeUsers' },
          { name: 'newUsers' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'purchaseRevenue' },
          { name: 'transactions' },
        ],
      }),
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            inListFilter: { values: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'] },
          },
        },
      }),
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'purchaseRevenue' }, { name: 'transactions' }, { name: 'sessions' }, { name: 'activeUsers' }, { name: 'itemsViewed' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      }),
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'averageSessionDuration' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      }),
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'transactions' }, { name: 'purchaseRevenue' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 15,
      }),
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      }),
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'itemName' }],
        metrics: [{ name: 'itemsViewed' }, { name: 'itemsAddedToCart' }],
        orderBys: [{ metric: { metricName: 'itemsViewed' }, desc: true }],
        limit: 50,
      }),
      // 페이지별 이탈률 (이탈 포인트 분석)
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'pagePath' }],
        metrics: [
          { name: 'sessions' },
          { name: 'bounceRate' },
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 20,
      }),
      // 날짜별 소스/매체 세션 분포
      runReport(token, {
        dateRanges: [dateRange],
        dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'sessionMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 2000,
      }),
    ]);

    return res.status(200).json({
      overview: parseRows(overviewRaw)[0] || {},
      funnel: parseRows(funnelRaw),
      revenueOverTime: parseRows(revenueRaw),
      topPages: parseRows(pagesRaw),
      trafficSources: parseRows(sourcesRaw),
      devices: parseRows(devicesRaw),
      itemViews: parseRows(itemViewsRaw),
      exitPages: parseRows(exitPagesRaw),
      trafficSourcesOverTime: parseRows(sourcesByDateRaw),
    });
  } catch (error) {
    console.error('[Analytics]', error);
    return res.status(500).json({
      error: 'Failed to fetch analytics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
