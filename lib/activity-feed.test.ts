import { describe, it, expect } from "vitest";
import { buildActivityFeedXml, escapeXml } from "@/lib/activity-feed";
import type { ActivityEntry } from "@/lib/data";

// --- Shared fixtures ---

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    kind: "create",
    facilityId: "test-facility-1",
    facilityName: "Test Facility",
    label: "new facility added",
    timestamp: new Date("2026-07-20T12:00:00Z"),
    ...overrides,
  };
}

describe("buildActivityFeedXml", () => {
  it("produces a valid, empty channel when there are no entries", () => {
    const xml = buildActivityFeedXml([]);

    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<channel>");
    expect(xml).toContain("<title>Compute Atlas — Recent activity</title>");
    expect(xml).not.toContain("<item>");
    expect(xml).not.toContain("<lastBuildDate>");
  });

  it("serializes a single entry into one item with link, guid, pubDate, and title", () => {
    const entry = makeEntry();
    const xml = buildActivityFeedXml([entry]);

    const itemMatches = xml.match(/<item>/g) ?? [];
    expect(itemMatches).toHaveLength(1);
    expect(xml).toContain(
      "<link>https://www.compute-atlas.com/facilities/test-facility-1</link>"
    );
    expect(xml).toContain('<guid isPermaLink="false">');
    expect(xml).toContain("<pubDate>");
    expect(xml).toContain(entry.label);
  });

  it("escapes XML-unsafe characters in facility names and leaks no raw markup", () => {
    const entry = makeEntry({
      facilityName: `Foo & Bar <script> "x" 'y'`,
    });
    const xml = buildActivityFeedXml([entry]);

    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&gt;");
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&apos;");
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("Bar <script>");
  });

  it("produces a stable guid across repeated builds of the same entry", () => {
    const entry = makeEntry();
    const first = buildActivityFeedXml([entry]);
    const second = buildActivityFeedXml([entry]);

    const extractGuid = (xml: string) =>
      xml.match(/<guid isPermaLink="false">([^<]+)<\/guid>/)?.[1];

    expect(extractGuid(first)).toBeDefined();
    expect(extractGuid(first)).toBe(extractGuid(second));
  });

  it("sets lastBuildDate to the first entry's timestamp when entries are present", () => {
    const newest = makeEntry({
      facilityId: "facility-a",
      timestamp: new Date("2026-07-20T12:00:00Z"),
    });
    const older = makeEntry({
      facilityId: "facility-b",
      timestamp: new Date("2026-07-19T08:00:00Z"),
    });
    const xml = buildActivityFeedXml([newest, older]);

    expect(xml).toContain(
      `<lastBuildDate>${newest.timestamp.toUTCString()}</lastBuildDate>`
    );
  });
});

describe("escapeXml", () => {
  it("strips illegal C0 control characters", () => {
    const withControlChar = `a${String.fromCharCode(1)}b`;
    expect(escapeXml(withControlChar)).toBe("ab");
  });

  it("encodes the five XML special characters", () => {
    expect(escapeXml("&")).toBe("&amp;");
    expect(escapeXml("<")).toBe("&lt;");
    expect(escapeXml(">")).toBe("&gt;");
    expect(escapeXml('"')).toBe("&quot;");
    expect(escapeXml("'")).toBe("&apos;");
  });
});
