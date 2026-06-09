import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Admin 프로젝트에서만 실행 — 메인 프로젝트 cron 중복 방지
  if (!process.env.CRON_ENABLED) {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const igToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igId = process.env.INSTAGRAM_ACCOUNT_ID;
  if (!igToken || !igId) {
    return res.status(500).json({ error: 'Instagram not configured' });
  }

  try {
    // Instagram 현재 팔로워 수 조회
    const url = new URL(`https://graph.facebook.com/v21.0/${igId}`);
    url.searchParams.set('fields', 'followers_count');
    url.searchParams.set('access_token', igToken);
    const igRes = await fetch(url.toString());
    const igData = await igRes.json() as { followers_count?: number; error?: { message: string } };
    if (!igRes.ok) throw new Error(igData.error?.message ?? `Instagram API ${igRes.status}`);

    const followersCount = igData.followers_count;
    if (typeof followersCount !== 'number') throw new Error('followers_count missing in response');

    // 오늘 날짜 (JST 기준)
    const now = new Date();
    now.setTime(now.getTime() + 9 * 60 * 60 * 1000);
    const todayJST = now.toISOString().slice(0, 10);

    // Supabase에 upsert (같은 날짜 중복 실행해도 안전)
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { error } = await supabase
      .from('instagram_follower_snapshots')
      .upsert({ date: todayJST, followers_count: followersCount }, { onConflict: 'date' });
    if (error) throw new Error(error.message);

    console.log(`[instagram-follower-cron] ${todayJST}: ${followersCount.toLocaleString()} followers`);
    return res.status(200).json({ ok: true, date: todayJST, followers: followersCount });
  } catch (err) {
    console.error('[instagram-follower-cron]', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
}
