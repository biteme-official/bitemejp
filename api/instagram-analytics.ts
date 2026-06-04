import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const IG_BASE = 'https://graph.facebook.com/v21.0';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

async function igGet(path: string, params: Record<string, string>) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN!;
  const url = new URL(`${IG_BASE}${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const msg = (json?.error as { message?: string } | undefined)?.message;
    throw new Error(msg || `IG API ${res.status}`);
  }
  return json;
}

function getRangeDates(range: string, from?: string, to?: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const until = new Date(today);
  until.setDate(until.getDate() + 1);
  let since = new Date(today);

  if (range === 'custom' && from && to) {
    since = new Date(from + 'T00:00:00');
    until.setTime(new Date(to + 'T00:00:00').getTime() + 86400000);
  } else if (range === 'today') {
    // since = today
  } else if (range === '7d') {
    since.setDate(since.getDate() - 7);
  } else if (range === '90d') {
    since.setDate(since.getDate() - 90);
  } else {
    since.setDate(since.getDate() - 28);
  }
  return { since, until };
}

interface MediaItem {
  id: string;
  timestamp: string;
  like_count: number;
  comments_count: number;
  media_type: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization;
  if (!ADMIN_SECRET || auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ message: 'UNAUTHORIZED' });
  }
  if (!process.env.INSTAGRAM_ACCESS_TOKEN || !process.env.INSTAGRAM_ACCOUNT_ID) {
    return res.status(200).json({ daily: [], currentFollowers: 0, configured: false });
  }

  const igId = process.env.INSTAGRAM_ACCOUNT_ID!;
  const { range = '28d', from, to } = req.query as Record<string, string>;
  const { since, until } = getRangeDates(range, from, to);

  const sinceISO = since.toISOString().slice(0, 10);
  const untilISO = new Date(until.getTime() - 1).toISOString().slice(0, 10);

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // 현재 팔로워 수 + 게시글 + Supabase 히스토리 병렬 조회
    const sinceMs = since.getTime();
    const untilMs = until.getTime();

    const [accountRes, mediaRes, snapshotsRes] = await Promise.all([
      igGet(`/${igId}`, { fields: 'followers_count' }).catch(() => null),
      igGet(`/${igId}/media`, {
        fields: 'id,timestamp,like_count,comments_count,media_type',
        limit: '100',
      }).catch(() => null),
      supabase
        .from('instagram_follower_snapshots')
        .select('date, followers_count')
        .gte('date', sinceISO)
        .lte('date', untilISO)
        .order('date', { ascending: true }),
    ]);

    const currentFollowers = (accountRes?.followers_count as number) ?? 0;

    // Supabase 히스토리로 팔로워 맵 구성 (날짜별 누적 수)
    const followerByDate = new Map<string, number>();
    for (const snap of snapshotsRes.data ?? []) {
      followerByDate.set(snap.date as string, snap.followers_count as number);
    }

    // 오늘 날짜를 현재 팔로워 수로 보정 (크론이 아직 안 돌았거나 당일 실시간 반영)
    const todayISO = new Date().toISOString().slice(0, 10);
    if (currentFollowers > 0) {
      followerByDate.set(todayISO, currentFollowers);
    }

    // 게시글 인사이트
    const mediaItems = ((mediaRes?.data as MediaItem[] | undefined) ?? [])
      .filter((m) => m.media_type !== 'STORY')
      .filter((m) => {
        const ts = new Date(m.timestamp).getTime();
        return ts >= sinceMs && ts < untilMs;
      });

    const postInsights = await Promise.all(
      mediaItems.slice(0, 50).map(async (media) => {
        const date = media.timestamp.slice(0, 10);
        try {
          const insights = await igGet(`/${media.id}/insights`, {
            metric: 'reach,total_interactions',
          });
          const iMap: Record<string, number> = {};
          for (const m of (insights.data as { name: string; values: { value: number }[] }[])) {
            iMap[m.name] = m.values?.[0]?.value ?? 0;
          }
          return {
            date,
            reach: iMap['reach'] ?? 0,
            engagement: iMap['total_interactions'] ?? (media.like_count + media.comments_count),
          };
        } catch {
          return { date, reach: 0, engagement: media.like_count + media.comments_count };
        }
      })
    );

    const postByDate = new Map<string, { count: number; reach: number; engagement: number }>();
    for (const p of postInsights) {
      const ex = postByDate.get(p.date) ?? { count: 0, reach: 0, engagement: 0 };
      ex.count++;
      ex.reach += p.reach;
      ex.engagement += p.engagement;
      postByDate.set(p.date, ex);
    }

    // 날짜 시퀀스 생성
    const dates: string[] = [];
    const cur = new Date(since);
    while (cur < until) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }

    // 일별 데이터 조립
    let prevFollowers: number | null = null;
    const daily = dates.map((date) => {
      const followers = followerByDate.get(date) ?? null;
      const delta = prevFollowers !== null && followers !== null ? followers - prevFollowers : null;
      if (followers !== null) prevFollowers = followers;
      const posts = postByDate.get(date) ?? { count: 0, reach: 0, engagement: 0 };
      return {
        date,
        followerDelta: delta,
        cumulativeFollowers: followers,
        postsPublished: posts.count,
        postReach: posts.reach,
        postEngagement: posts.engagement,
      };
    });

    return res.status(200).json({ daily, currentFollowers, configured: true });
  } catch (err) {
    return res.status(500).json({
      message: err instanceof Error ? err.message : 'Instagram API 오류',
      configured: true,
    });
  }
}
