/**
 * /api/line-click — 라인 발송 링크의 클릭 추적 리다이렉트.
 *
 * 장바구니 이탈 복구 저니는 Shopify 가 준 복구 URL 을 그대로 보낸다. 그 주소는 이미
 * 만들어진 체크아웃을 다시 여는 것이라 우리 프론트를 거치지 않고, 따라서 UTM 이 주문에
 * 안 붙는다 — 이 저니만 링크 기여가 「셀 수 없음」이던 이유다.
 *
 * 그래서 도착지는 그대로 두고 **우리 도메인을 한 번 거치게** 한다.
 *
 *   LINE 메시지 → biteme.co.jp/api/line-click?t=… → (302) → 같은 복구 URL
 *
 * ⚠️ 이 경로에 고객의 결제가 걸려 있다. 여기서 지키는 규칙:
 *
 *   1. 도착지는 원래 URL 과 **바이트 단위로 같아야** 한다. 파라미터 하나(`key`)만 잃어도
 *      복구 링크는 열리지 않는다.
 *   2. **어떤 실패에도 오류 화면을 보이지 않는다.** 서명이 깨졌든 토큰이 이상하든
 *      최소한 사이트 첫 화면으로는 보낸다. 여기서 500 을 내면 그 사람은 그냥 이탈이다.
 *   3. 클릭 기록은 **곁다리**다. Supabase 가 죽어 있어도 리다이렉트는 나가야 하므로
 *      짧은 타임아웃을 걸고 실패는 삼킨다.
 *
 * 오픈 리다이렉트 방지: 토큰은 HMAC 로 서명하고, 목적지 호스트는 우리 상점으로 고정한다.
 * 토큰에는 경로+쿼리만 담기므로 서명이 뚫려도 우리 상점 밖으로는 못 보낸다.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';

export const CLICK_EVENT = 'line_click';

/**
 * 기록이 늦어도 고객을 붙잡아 두지 않는다.
 * 평시 Supabase 삽입은 100ms 안쪽이고, 이 상한은 장애 때 고객이 더 기다리는 최대치다.
 */
const LOG_TIMEOUT_MS = 500;

const FALLBACK_URL = 'https://biteme.co.jp/';

/**
 * 링크 미리보기·크롤러가 만드는 가짜 클릭.
 *
 * 복구 링크는 한 사람당 하나뿐이라 집계에서 ref 단위로 접으면 중복은 자연히 사라지지만,
 * **누르지 않았는데 미리보기만 다녀간 것**은 접어도 한 건으로 남는다. UA 로 한 번 거른다.
 */
const BOT_UA = /bot|crawler|spider|preview|facebookexternalhit|slackbot|twitterbot|whatsapp|telegram|line-?poker/i;

function shopHost(): string {
  return process.env.VITE_SHOPIFY_STORE_DOMAIN || 'biteme-jp.myshopify.com';
}

/** 토큰에 담는 것은 목적지의 경로+쿼리와 이탈 결제 id 뿐이다. 개인 식별자는 싣지 않는다. */
export function signClick(pathWithSearch: string, ref: string, secret: string): string {
  const body = Buffer.from(`${pathWithSearch}|${ref}`, 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** 96비트로 자른다. 링크 길이가 곧 고객이 보는 인상이고, 이 서명이 지키는 것은 목적지 호스트뿐이다. */
function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url').slice(0, 16);
}

function verify(token: string, secret: string): { path: string; ref: string } | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body, secret));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;

  const decoded = Buffer.from(body, 'base64url').toString('utf8');
  const bar = decoded.lastIndexOf('|');
  if (bar <= 0) return null;
  const path = decoded.slice(0, bar);
  // `//evil.com` 은 브라우저가 프로토콜 상대 URL 로 읽어 외부로 나간다. 호스트를 붙이기 전에 막는다.
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return { path, ref: decoded.slice(bar + 1) };
}

async function logClick(req: VercelRequest, ref: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;

  const ua = String(req.headers['user-agent'] ?? '');
  const row = {
    event_type: CLICK_EVENT,
    session_id: `checkout:${ref}`,
    properties: {
      journey: 'cart_recovery',
      ref,
      bot: BOT_UA.test(ua) || !ua,
      // 진짜 브라우저 이동인지. 미리보기 크롤러는 이 헤더를 붙이지 않는다.
      nav: req.headers['sec-fetch-dest'] === 'document' || req.headers['sec-fetch-mode'] === 'navigate',
      ua: ua.slice(0, 200),
    },
    page_path: '/journey/cart_recovery',
    referrer: null,
  };

  // supabase-js 를 쓰지 않는다. 이 함수는 고객 앞에 서 있어서 콜드스타트 한 줌도 아깝다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOG_TIMEOUT_MS);
  try {
    await fetch(`${url}/rest/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
      signal: controller.signal,
    });
  } catch (e) {
    console.error('[LINE Click] 클릭 기록 실패(리다이렉트는 정상):', e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 캐시가 끼면 클릭이 한 번만 잡히거나 엉뚱한 사람에게 남의 체크아웃이 열린다.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const secret = process.env.LINE_CHANNEL_SECRET;
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const parsed = secret && token ? verify(token, secret) : null;

  if (!parsed) {
    // 여기서 오류를 보여줄 이유가 없다. 고객은 장바구니를 열러 온 사람이다.
    if (!secret) console.error('[LINE Click] 🔴 LINE_CHANNEL_SECRET 미설정');
    else if (token) console.error('[LINE Click] 서명 불일치 — 사이트로 보냄');
    return res.redirect(302, FALLBACK_URL);
  }

  const target = `https://${shopHost()}${parsed.path}`;

  // HEAD 는 링크 미리보기다. 기록하지 않고 길만 알려준다.
  if (req.method === 'HEAD') {
    res.setHeader('Location', target);
    return res.status(302).end();
  }

  await logClick(req, parsed.ref);
  return res.redirect(302, target);
}
