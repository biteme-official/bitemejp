/**
 * 메인 배너 자체 관리 API (#194) — Shopify 메타오브젝트를 거치지 않는다.
 *
 *  GET  /api/home-banners                     공개. 문서 전체 { source:'doc', doc } / 없으면 { source:'none' }
 *                                             엣지 60초 캐시. 노출 기간 판정은 프론트가 한다(캐시 때문에 서버에서 거르지 않음)
 *  POST /api/home-banners  action=save        { doc }                          문서 저장(+ 타임스탬프 백업)
 *  POST /api/home-banners  action=upload      { name, type, data(base64) }     이미지 업로드 → { url }
 *
 * 저장소: Supabase Storage 공개 버킷 `home-banners`
 *   banners.json            현재 문서
 *   backups/<ISO>.json      저장할 때마다 직전 문서 사본(되돌리기용)
 *   images/<ts>-<name>      업로드 이미지
 * 표(테이블)·마이그레이션이 없다 — 문서 하나라 SQL 에디터를 열 일이 없다. 버킷은 첫 쓰기 때 만든다.
 *
 * 인증: POST 는 Authorization: Bearer ADMIN_SECRET (다른 어드민 API 와 동일).
 * 같은 오리진(biteme.co.jp)의 /admin 이 부르므로 CORS 없음. 어드민 전용 Vercel 프로젝트가 아니라
 * 본 프로젝트 함수인 이유: 가벼운 읽기/쓰기뿐이고, 프리뷰 브랜치에서도 바로 검증되게.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'home-banners';
const DOC_PATH = 'banners.json';
const MAX_BANNERS = 30;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

let client: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정');
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

async function ensureBucket(sb: SupabaseClient) {
  const { data } = await sb.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_IMAGE_BYTES });
  // 동시 생성 경합이면 이미 있다는 오류 — 무시
  if (error && !/already exists/i.test(error.message)) throw error;
}

function authorized(req: VercelRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  return (req.headers.authorization || '') === `Bearer ${secret}`;
}

// ── 문서 검증 ─────────────────────────────────────────────────────────────
// 프론트 타입(src/lib/homeBanners.ts)과 같은 모양. 여기서는 모양만 맞추고 값은 자른다 — 저장 실패보다 잘린 저장이 낫다.
type Tone = 'dark' | 'light';
type CtaStyle = 'text' | 'button';
type MobileRatio = '4:3' | '1:1' | 'strip';

interface BannerText { badge: string; subtext: string; headline: string; cta: string; tone: Tone; ctaStyle: CtaStyle }
interface Photo { url: string; width: number; height: number; cropTop: number }
interface Banner {
  id: string; name: string; enabled: boolean;
  startAt: string | null; endAt: string | null; link: string | null;
  pcImage: string | null; photo: Photo | null; mobileImage: string | null; bg: string; text: BannerText;
}
interface Doc { version: 1; updatedAt: string; settings: { mobileRatio: MobileRatio }; banners: Banner[] }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const urlOrNull = (v: unknown): string | null => {
  const s = strOrNull(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};
const photoOrNull = (v: unknown): Photo | null => {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const url = urlOrNull(p.url);
  const width = Number(p.width);
  const height = Number(p.height);
  if (!url || !(width > 0) || !(height > 0)) return null;
  const cropTop = Number(p.cropTop);
  return { url, width: Math.round(width), height: Math.round(height), cropTop: Number.isFinite(cropTop) ? Math.min(0.6, Math.max(0, cropTop)) : 0 };
};
const color = (v: unknown): string => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '#f5f5f5');

function normalizeDoc(input: unknown): Doc | null {
  if (!input || typeof input !== 'object') return null;
  const d = input as Record<string, unknown>;
  if (!Array.isArray(d.banners)) return null;
  const settingsIn = (d.settings ?? {}) as Record<string, unknown>;
  const ratio = settingsIn.mobileRatio;
  const mobileRatio: MobileRatio = ratio === '1:1' || ratio === '4:3' ? ratio : 'strip';

  const banners: Banner[] = d.banners.slice(0, MAX_BANNERS).map((raw, i) => {
    const b = (raw ?? {}) as Record<string, unknown>;
    const t = (b.text ?? {}) as Record<string, unknown>;
    return {
      id: str(b.id, 40) || `b_${Date.now().toString(36)}_${i}`,
      name: str(b.name, 100),
      enabled: b.enabled !== false,
      startAt: isoOrNull(b.startAt),
      endAt: isoOrNull(b.endAt),
      link: urlOrNull(b.link),
      pcImage: urlOrNull(b.pcImage),
      photo: photoOrNull(b.photo),
      mobileImage: urlOrNull(b.mobileImage),
      bg: color(b.bg),
      text: {
        badge: str(t.badge, 30),
        subtext: str(t.subtext, 120),
        headline: str(t.headline, 120),
        cta: str(t.cta, 40),
        tone: t.tone === 'light' ? 'light' : 'dark',
        ctaStyle: t.ctaStyle === 'button' ? 'button' : 'text',
      },
    };
  });
  return { version: 1, updatedAt: new Date().toISOString(), settings: { mobileRatio }, banners };
}

// ── 저장소 ────────────────────────────────────────────────────────────────
async function readDoc(sb: SupabaseClient): Promise<Doc | null> {
  const { data, error } = await sb.storage.from(BUCKET).download(DOC_PATH);
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as Doc;
  } catch {
    return null;
  }
}

async function writeJson(sb: SupabaseClient, path: string, doc: Doc) {
  const body = Buffer.from(JSON.stringify(doc), 'utf8');
  const { error } = await sb.storage.from(BUCKET).upload(path, body, { contentType: 'application/json', upsert: true, cacheControl: '0' });
  if (error) throw error;
}

// ── 핸들러 ────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    try {
      const sb = getSupabase();
      const doc = await readDoc(sb);
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      if (!doc) return res.status(200).json({ source: 'none' });
      return res.status(200).json({ source: 'doc', doc });
    } catch (e) {
      // 저장소가 죽어도 프론트는 none 을 받고 Shopify 로 간다
      console.error('[home-banners] read failed', e);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ source: 'none' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = body.action;

  try {
    const sb = getSupabase();
    await ensureBucket(sb);

    if (action === 'save') {
      const doc = normalizeDoc(body.doc);
      if (!doc) return res.status(400).json({ error: 'doc 형식이 아닙니다' });
      const prev = await readDoc(sb);
      if (prev) await writeJson(sb, `backups/${(prev.updatedAt || new Date().toISOString()).replace(/[:.]/g, '-')}.json`, prev);
      await writeJson(sb, DOC_PATH, doc);
      return res.status(200).json({ ok: true, doc });
    }

    if (action === 'upload') {
      const type = str(body.type, 40);
      const ext = ALLOWED_TYPES[type];
      if (!ext) return res.status(400).json({ error: 'jpg / png / webp / gif 만 올릴 수 있습니다' });
      const data = typeof body.data === 'string' ? body.data : '';
      const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (buf.length === 0) return res.status(400).json({ error: '파일이 비었습니다' });
      if (buf.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: '이미지는 3MB 까지' });
      const base = str(body.name, 80).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'banner';
      const path = `images/${Date.now().toString(36)}-${base}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: false, cacheControl: '31536000' });
      if (error) throw error;
      const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
      return res.status(200).json({ ok: true, url: pub.publicUrl });
    }

    return res.status(400).json({ error: `알 수 없는 action: ${String(action)}` });
  } catch (e) {
    console.error('[home-banners] write failed', e);
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
