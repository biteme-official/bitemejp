import type { VercelRequest, VercelResponse } from '@vercel/node';

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
    const errMsg = (json?.error as { message?: string } | undefined)?.message;
    throw new Error(errMsg || `Instagram API ${res.status}`);
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
    // keep since = today
  } else if (range === '7d') {
    since.setDate(since.getDate() - 7);
  } else if (range === '90d') {
    since.setDate(since.getDate() - 90);
  } else {
    // default: 28d
    since.setDate(since.getDate() - 28);
  }
  return { since, until };
}

interface InsightValue { value: number; end_time: string }
interface InsightMetric { name: string; values: InsightValue[] }
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
  const sinceUnix = Math.floor(since.getTime() / 1000).toString();
  const untilUnix = Math.floor(until.getTime() / 1000).toString();

  try {
    const [accountRes, profileViewsRes, followerCountRes, mediaRes] = await Promise.all([
      igGet(`/${igId}`, { fields: 'followers_count' }).catch(() => null),
      igGet(`/${igId}/insights`, {
        metric: 'profile_views',
        period: 'day',
        since: sinceUnix,
        until: untilUnix,
      }).catch(() => null),
      igGet(`/${igId}/insights`, {
        metric: 'follower_count',
        period: 'day',
        since: sinceUnix,
        until: untilUnix,
      }).catch(() => null),
      igGet(`/${igId}/media`, {
        fields: 'id,timestamp,like_count,comments_count,media_type',
        limit: '100',
      }).catch(() => null),
    ]);

    const currentFollowers = (accountRes?.followers_count as number) ?? 0;

    const profileViewsByDate = new Map<string, number>();
    for (const metric of (profileViewsRes?.data as InsightMetric[] | undefined) ?? []) {
      if (metric.name === 'profile_views') {
        for (const val of metric.values) {
          profileViewsByDate.set(val.end_time.slice(0, 10), val.value);
        }
      }
    }

    const followerByDate = new Map<string, number>();
    for (const metric of (followerCountRes?.data as InsightMetric[] | undefined) ?? []) {
      if (metric.name === 'follower_count') {
        for (const val of metric.values) {
          followerByDate.set(val.end_time.slice(0, 10), val.value);
        }
      }
    }

    const sinceMs = since.getTime();
    const untilMs = until.getTime();
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

    // Build daily data for each date in range
    const dates: string[] = [];
    const cur = new Date(since);
    while (cur < until) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }

    let prevFollowers: number | null = null;
    const daily = dates.map((date) => {
      const followers = followerByDate.get(date) ?? null;
      const delta = prevFollowers !== null && followers !== null ? followers - prevFollowers : null;
      if (followers !== null) prevFollowers = followers;
      const posts = postByDate.get(date) ?? { count: 0, reach: 0, engagement: 0 };
      return {
        date,
        profileViews: profileViewsByDate.get(date) ?? 0,
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
