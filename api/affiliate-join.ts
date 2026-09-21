/**
 * /api/affiliate-join — 파트너 셀프 가입 (#178 Phase 2, 설계 §3·§7, 약관 第2条)
 *
 *   POST { lineSessionToken, instagram?, name?, adultConfirmed: true, termsAgreed: true, termsVersion }
 *   → 201 { ok, partner: { code, link, status, joinedAt }, created: true }
 *   → 200 { ok, partner, created: false }        이미 파트너면 그대로 돌려준다 (1 LINE = 1 파트너)
 *   → 400 { error: 'not_member' }                 세션에 Shopify 고객 GID 가 없음 — 회원 확인 불가, 재로그인 안내
 *   → 400 { error: 'consent_required' }           체크박스 둘 중 하나라도 빠짐
 *   → 401 { error: 'unauthorized' }               세션 토큰 없음·위조·만료
 *
 * 규칙
 *  - 🔴 파트너 = 회원. 서명 세션의 shopifyCustomerId 가 없으면 가입하지 않는다 (LINE 동기화 실패 계정, 설계 §8 11).
 *  - 18세 확약·약관 동의 시각을 서버 시각으로 남긴다 (第2条 2항·第11条 4항).
 *  - 정지(suspended)·탈퇴(withdrawn) 이력이 있는 LINE 계정은 재가입 불가 (第2条 1항 3호). 재가입 요청은 사람이 판단.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomInt } from 'crypto';
import { getSupabase, isAffiliateEnabled, publicPartner, verifyLineSession, type AffPartner } from './_affiliate.js';

const ALLOWED_ORIGINS = ['https://biteme.co.jp', 'https://www.biteme.co.jp', 'http://localhost:5173'];
/** 헷갈리는 글자(0/O, 1/I) 를 뺀 알파벳·숫자 — 파트너가 손으로 옮겨 적어도 틀리지 않게 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

function getCorsOrigin(req: VercelRequest): string {
  const origin = String(req.headers.origin ?? '');
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function genCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

function sanitizeInstagram(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(v) ? v : null;
}

function sanitizeName(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  return v.slice(0, 60);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!isAffiliateEnabled()) return res.status(503).json({ error: 'disabled' });

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return res.status(500).json({ error: 'server_misconfigured' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const session = verifyLineSession(body.lineSessionToken, secret);
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  try {
    const sb = getSupabase();

    // 이미 파트너면 그대로 — 체크박스를 다시 받지 않는다
    const { data: existing, error: exErr } = await sb.from('aff_partners').select('*').eq('line_user_id', session.lineUserId).maybeSingle();
    if (exErr) throw new Error(exErr.message);
    if (existing) {
      const p = existing as AffPartner;
      if (p.status !== 'active') return res.status(403).json({ error: 'not_eligible', status: p.status });
      return res.status(200).json({ ok: true, created: false, partner: publicPartner(p) });
    }

    // 회원 확인 — Shopify 고객 GID 가 세션에 없으면 보류 (설계 §3 2단계)
    const customerId = session.shopifyCustomerId ? String(session.shopifyCustomerId).split('/').pop() ?? null : null;
    if (!customerId) return res.status(400).json({ error: 'not_member' });

    if (body.adultConfirmed !== true || body.termsAgreed !== true) return res.status(400).json({ error: 'consent_required' });
    const termsVersion = typeof body.termsVersion === 'string' && /^[0-9]{4}-[0-9]{2}$/.test(body.termsVersion) ? body.termsVersion : null;
    if (!termsVersion) return res.status(400).json({ error: 'consent_required' });

    const now = new Date().toISOString();
    const name = sanitizeName(body.name) || `LINE ${session.lineUserId.slice(-6)}`;
    const instagram = sanitizeInstagram(body.instagram);

    // 코드 충돌은 32^6 ≈ 10억 분의 1 — 그래도 유니크 위반이면 몇 번 다시 뽑는다
    let inserted: (AffPartner) | null = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const { data, error } = await sb
        .from('aff_partners')
        .insert({
          code: genCode(),
          line_user_id: session.lineUserId,
          shopify_customer_id: customerId,
          name,
          instagram,
          status: 'active',
          terms_version: termsVersion,
          agreed_at: now,
          adult_confirmed_at: now,
        })
        .select('*')
        .single();
      if (!error) { inserted = data as AffPartner; break; }
      const dupCode = /aff_partners_code_key/.test(error.message);
      const dupLine = /aff_partners_line_user_id_key/.test(error.message);
      if (dupLine) {
        // 같은 순간 두 번 눌린 경우 — 이미 생긴 행을 돌려준다
        const { data: again } = await sb.from('aff_partners').select('*').eq('line_user_id', session.lineUserId).maybeSingle();
        if (again) return res.status(200).json({ ok: true, created: false, partner: publicPartner(again as AffPartner) });
      }
      if (!dupCode) throw new Error(error.message);
    }
    if (!inserted) throw new Error('code generation exhausted');

    console.log(`[Affiliate] 가입 ${inserted.code} (terms ${termsVersion})`);
    return res.status(201).json({ ok: true, created: true, partner: publicPartner(inserted) });
  } catch (err) {
    console.error('[Affiliate] 🔴 가입 실패:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'internal' });
  }
}
