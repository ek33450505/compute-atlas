import { describe, it, expect } from "vitest";
import { GET } from "./route";

// Thin route test: the RSS body-building is covered by lib/activity-feed.test.ts
// (the pure buildActivityFeedXml). This asserts the route's own contract — the
// RSS content-type + caching headers, and that it delegates to the feed builder
// and returns a valid RSS 2.0 envelope. In the test env DATABASE_URL is unset,
// so getRecentActivity degrades to an empty feed (lib/data.ts) — a deterministic,
// dataset-count-free fixture that also exercises the empty-feed resilience path.

describe("GET /activity/feed.xml", () => {
  it("responds 200 with the RSS content-type", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
  });

  it("carries a public, cacheable Cache-Control header", async () => {
    const res = await GET();
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=");
  });

  it("returns a valid RSS 2.0 feed envelope built by buildActivityFeedXml", async () => {
    const res = await GET();
    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('<rss version="2.0"');
    expect(body).toContain("<channel>");
    expect(body).toContain("Recent activity"); // channel title from the builder
    expect(body).toContain('rel="self"'); // atom:self link
    expect(body).toContain("/activity/feed.xml");
    expect(body.trimEnd().endsWith("</rss>")).toBe(true);
  });

  it("renders a valid empty feed when there is no activity (no <item>s)", async () => {
    const res = await GET();
    const body = await res.text();
    // Empty feed is still a valid channel: no <item> elements, no <lastBuildDate>.
    expect(body).not.toContain("<item>");
    expect(body).not.toContain("<lastBuildDate>");
  });
});
