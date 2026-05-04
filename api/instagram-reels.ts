import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Instagram access token not configured' });

  try {
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account&access_token=${token}`
    );
    const pages = await pagesRes.json();

    const igId = pages.data?.[0]?.instagram_business_account?.id;
    if (!igId) return res.status(404).json({ error: 'No Instagram business account found' });

    const mediaRes = await fetch(
      `https://graph.facebook.com/v21.0/${igId}/media?fields=id,media_type,media_url,thumbnail_url,permalink,caption,timestamp&limit=20&access_token=${token}`
    );
    const media = await mediaRes.json();

    const reels = (media.data || []).filter(
      (item: { media_type: string }) =>
        item.media_type === 'REELS' || item.media_type === 'VIDEO'
    );

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ reels });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch Instagram media' });
  }
}
