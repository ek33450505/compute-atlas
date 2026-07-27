import { getRecentActivity } from "@/lib/data";
import { buildActivityFeedXml } from "@/lib/activity-feed";

// Mirror the /activity page's 1-hour ISR window: the feed reads the DB at most
// once per hour (same frugality posture as the sitemap + /activity page), and
// reuses the same getRecentActivity read path — no new per-request DB load.
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  const entries = await getRecentActivity(50);
  const xml = buildActivityFeedXml(entries);
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
