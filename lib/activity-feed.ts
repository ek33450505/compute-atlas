import type { ActivityEntry } from "@/lib/data";
import { siteConfig } from "@/lib/site";
import { escapeXml } from "@/lib/xml";

const ACTIVITY_PATH = "/activity";
const FEED_PATH = "/activity/feed.xml";

// Moved to lib/xml.ts (2026-09-25) so the sitemap serializers in
// lib/sitemap-xml.ts can share the same escaping logic without importing
// this feed module. Re-exported here so existing callers/imports of
// escapeXml from "@/lib/activity-feed" keep working unchanged.
export { escapeXml } from "@/lib/xml";

/**
 * Serializes activity entries into an RSS 2.0 feed document. Pure + deterministic
 * (no `new Date()` / Math.random) so it is fully unit-testable. An empty `entries`
 * array yields a valid channel with no <item>s and no <lastBuildDate>.
 */
export function buildActivityFeedXml(entries: ActivityEntry[]): string {
  const base = siteConfig.url;

  const items = entries.map((entry) => {
    const link = entry.facilityId
      ? `${base}/facilities/${entry.facilityId}`
      : `${base}${ACTIVITY_PATH}`;
    const title = `${entry.facilityName} — ${entry.label}`;
    const description = entry.attribution
      ? `${title} · contributed by ${entry.attribution}`
      : title;
    // Stable per-event id: same event → same guid across rebuilds, so aggregators don't re-notify.
    const guid = `${entry.facilityId}:${entry.kind}:${entry.timestamp.toISOString()}`;
    const pubDate = entry.timestamp.toUTCString(); // RFC-822 / RFC-1123

    return [
      "    <item>",
      `      <title>${escapeXml(title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="false">${escapeXml(guid)}</guid>`,
      `      <pubDate>${pubDate}</pubDate>`,
      `      <description>${escapeXml(description)}</description>`,
      "    </item>",
    ].join("\n");
  });

  const lastBuildDate =
    entries.length > 0 ? entries[0].timestamp.toUTCString() : undefined;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(`${siteConfig.name} — Recent activity`)}</title>`,
    `    <link>${base}${ACTIVITY_PATH}</link>`,
    `    <description>${escapeXml(
      `The latest facility updates and approved community contributions to ${siteConfig.name}.`
    )}</description>`,
    "    <language>en-us</language>",
    `    <atom:link href="${base}${FEED_PATH}" rel="self" type="application/rss+xml" />`,
    ...(lastBuildDate ? [`    <lastBuildDate>${lastBuildDate}</lastBuildDate>`] : []),
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
