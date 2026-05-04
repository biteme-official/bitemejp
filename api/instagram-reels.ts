import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Instagram access token not configured' });

  try {
    const igId = process.env.INSTAGRAM_ACCOUNT_ID;
    if (!igId) return res.status(500).json({ error: 'Instagram account ID not configured' });

    const fields = 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp';
    const baseUrl = `https://graph.facebook.com/v21.0/${igId}`;

    const [mediaRes, tagsRes] = await Promise.all([
      fetch(`${baseUrl}/media?fields=${fields}&limit=50&access_token=${token}`),
      fetch(`${baseUrl}/tags?fields=${fields}&limit=50&access_token=${token}`),
    ]);

    const [media, tags] = await Promise.all([mediaRes.json(), tagsRes.json()]);

    const isReel = (item: { media_type: string }) =>
      item.media_type === 'REELS' || item.media_type === 'VIDEO';

    const combined = [...(media.data || []), ...(tags.data || [])];
    const seen = new Set<string>();
    const reels = combined.filter((item: { id: string; media_type: string }) => {
      if (!isReel(item) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ reels });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch Instagram media' });
  }
}
