/**
 * /api/aff-click — 파트너 링크(/a/:code) 클릭 기록 + 회원이면 서버측 터치 (설계 §5, #178 Phase 1)
 *
 * 프론트가 리다이렉트 직전에 비동기로 쏜다(keepalive). 응답을 기다리지 않으므로
 * 여기서 무엇이 실패해도 고객 화면은 그대로 진행된다 — 이 함수는 곁다리다.
 *
 *   요청 { code, path?, lineSessionToken? }           → 클릭 1행 (+ 로그인 상태면 터치)
 *   응답 { ok, clickId? }                              → 프론트가 localStorage 에 clickId 를 보태 둔다
 *
 * 규칙
 *  - 🔴 고객 식별은 서명된 lineSessionToken 에서만 꺼낸다. 클라이언트가 보낸 userId 는 믿지 않는다.
 *  - 클릭 행에는 개인 식별자를 담지 않는다 (IP 는 해시만 — 약관 第10条).
 *  - 봇·링크 미리보기 UA 는 is_bot 으로 표시만 하고 터치는 남기지 않는다.
 *  - 정지·탈퇴 파트너의 코드는 기록하지 않는다 (약관 第12条: 탈퇴 즉시 링크 무효).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';
import {
  findActivePartner,
  getSupabase,
  isAffiliateEnabled,
  normalizeCode,
  recordTouch,
  verifyLineSession,
} from './_affiliate.js';

const ALLOWED_ORIGINS = [
  'https://biteme.co.jp',
  'https://www.biteme.co.jp',
  'http://localhost:5173',
];
const BOT_UA = /bot|crawler|spider|preview|facebookexternalhit|slackbot|twitterbot|whatsapp|telegram|line-?poker/i;

function getCorsOrigin(req: VercelRequest): string {
  const origin = String(req.headers.origin ?? '');
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function clientIpHash(req: VercelRequest): string | null {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (!ip) return null;
  // 원문 IP 는 남기지 않는다. 같은 IP 의 반복 클릭을 접을 수 있을 정도면 충분하다.
  return createHash('sha256').update(`aff|${ip}`).digest('hex').slice(0, 24);
}

function sanitizePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p.startsWith('/') || p.startsWith('//') || p.length > 300) return null;
  return p;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!isAffiliateEnabled()) return res.status(200).json({ ok: true, skipped: 'disabled' });

  // keepalive/sendBeacon 으로 오면 body 가 문자열일 수 있다 (api/line-cart.ts 와 같은 함정)
  let payload: unknown = req.body ?? {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return res.status(400).json({ ok: false, error: 'bad json' }); }
  }
  const body = (payload ?? {}) as { code?: unknown; path?: unknown; lineSessionToken?: unknown };

  const code = normalizeCode(body.code);
  if (!code) return res.status(200).json({ ok: true, skipped: 'bad-code' });

  try {
    const sb = getSupabase();
    const partner = await findActivePartner(sb, code);
    // 없는 코드·정지된 파트너: 조용히 무시. 링크를 누른 고객에게 보여줄 것은 없다.
    if (!partner) return res.status(200).json({ ok: true, skipped: 'no-partner' });

    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
    const isBot = BOT_UA.test(ua);
    const referrer = typeof req.headers.referer === 'string' ? req.headers.referer.slice(0, 500) : null;

    const { data: click, error } = await sb
      .from('aff_clicks')
      .insert({
        partner_id: partner.id,
        landing_path: sanitizePath(body.path),
        referrer,
        ua: ua || null,
        ip_hash: clientIpHash(req),
        is_bot: isBot,
      })
      .select('id')
      .single();
    if (error) throw new Error(`aff_clicks 저장 실패: ${error.message}`);
    const clickId = (click as { id: number }).id;

    // 로그인 상태면 회원 터치 — 귀속의 주 경로. 봇 UA 는 터치까지는 남기지 않는다.
    let touch: string | null = null;
    const secret = process.env.LINE_CHANNEL_SECRET;
    const session = !isBot && secret ? verifyLineSession(body.lineSessionToken, secret) : null;
    if (session) {
      touch = await recordTouch(sb, {
        lineUserId: session.lineUserId,
        partnerId: partner.id,
        touchedAt: new Date(),
        source: 'link',
        clickId,
        shopifyCustomerId: session.shopifyCustomerId ? session.shopifyCustomerId.split('/').pop() ?? null : null,
      });
    }

    return res.status(200).json({ ok: true, clickId, touch });
  } catch (err) {
    // 클릭 하나 놓치는 것보다 콘솔이 빨개지는 게 낫다 — 그래도 200. 고객이 할 수 있는 게 없다.
    console.error('[Affiliate] 🔴 aff-click 실패:', err instanceof Error ? err.message : err);
    return res.status(200).json({ ok: false });
  }
}
