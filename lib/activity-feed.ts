import type { ActivityEntry } from "@/lib/data";
import { siteConfig } from "@/lib/site";

const ACTIVITY_PATH = "/activity";
const FEED_PATH = "/activity/feed.xml";

/**
 * Escapes a string for safe inclusion in an XML text node/attribute, and strips
 * the C0 control chars that are illegal in XML 1.0 even when entity-encoded.
 * Facility names originate from the discovery pipeline and public contributions,
 * so every dynamic value MUST pass through here — this is the feed's injection guard.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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
    // Stable per-event id: same event → same guid across rebuilds, so aggregators don't re-notify.
    const guid = `${entry.facilityId}:${entry.kind}:${entry.timestamp.toISOString()}`;
    const pubDate = entry.timestamp.toUTCString(); // RFC-822 / RFC-1123

    return [
      "    <item>",
      `      <title>${escapeXml(title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="false">${escapeXml(guid)}</guid>`,
      `      <pubDate>${pubDate}</pubDate>`,
      `      <description>${escapeXml(title)}</description>`,
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
