import { describe, it, expect } from "vitest";
import { buildUrlsetXml, buildSitemapIndexXml } from "@/lib/sitemap-xml";

describe("buildUrlsetXml", () => {
  it("emits loc, lastmod, changefreq, priority in that order for a fully-populated entry", () => {
    const xml = buildUrlsetXml([
      {
        url: "https://example.com/a",
        lastModified: new Date("2026-01-01T00:00:00Z"),
        changeFrequency: "weekly",
        priority: 0.8,
      },
    ]);

    const locIndex = xml.indexOf("<loc>");
    const lastmodIndex = xml.indexOf("<lastmod>");
    const changefreqIndex = xml.indexOf("<changefreq>");
    const priorityIndex = xml.indexOf("<priority>");

    expect(locIndex).toBeGreaterThan(-1);
    expect(lastmodIndex).toBeGreaterThan(locIndex);
    expect(changefreqIndex).toBeGreaterThan(lastmodIndex);
    expect(priorityIndex).toBeGreaterThan(changefreqIndex);
  });

  it("omits lastmod, changefreq, and priority when absent from the entry", () => {
    const xml = buildUrlsetXml([{ url: "https://example.com/a" }]);

    expect(xml).toContain("<loc>https://example.com/a</loc>");
    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });

  it("emits priority 0 — a present number, not a falsy value to skip", () => {
    // Regression guard for the classic `if (item.priority)` bug: 0 is a
    // valid, meaningful priority and must still be serialized.
    const xml = buildUrlsetXml([{ url: "https://example.com/a", priority: 0 }]);

    expect(xml).toContain("<priority>0</priority>");
  });

  it("serializes a Date lastModified via toISOString", () => {
    const date = new Date("2026-03-15T08:30:00Z");
    const xml = buildUrlsetXml([{ url: "https://example.com/a", lastModified: date }]);

    expect(xml).toContain(`<lastmod>${date.toISOString()}</lastmod>`);
  });

  it("passes a string lastModified through unchanged", () => {
    const xml = buildUrlsetXml([
      { url: "https://example.com/a", lastModified: "2026-03-15" },
    ]);

    expect(xml).toContain("<lastmod>2026-03-15</lastmod>");
  });

  it("XML-escapes unsafe characters in the loc URL", () => {
    const xml = buildUrlsetXml([
      { url: "https://example.com/a?x=1&y=2<script>" },
    ]);

    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).not.toContain("<script>");
  });

  it("produces a well-formed, empty urlset for zero entries", () => {
    const xml = buildUrlsetXml([]);

    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    );
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<url>");
  });
});

describe("buildSitemapIndexXml", () => {
  it("emits an index entry's loc and lastmod when lastModified is set", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const xml = buildSitemapIndexXml([
      { loc: "https://example.com/sitemaps/static.xml", lastModified: date },
    ]);

    expect(xml).toContain("<loc>https://example.com/sitemaps/static.xml</loc>");
    expect(xml).toContain(`<lastmod>${date.toISOString()}</lastmod>`);
  });

  it("omits lastmod for an index entry with no lastModified", () => {
    const xml = buildSitemapIndexXml([
      { loc: "https://example.com/sitemaps/static.xml" },
    ]);

    expect(xml).toContain("<loc>https://example.com/sitemaps/static.xml</loc>");
    expect(xml).not.toContain("<lastmod>");
  });

  it("XML-escapes unsafe characters in an index entry's loc", () => {
    const xml = buildSitemapIndexXml([
      { loc: "https://example.com/sitemaps/a&b<c>.xml" },
    ]);

    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).not.toContain("<c>");
  });

  it("produces a well-formed, empty sitemapindex for zero children", () => {
    const xml = buildSitemapIndexXml([]);

    expect(xml).toContain(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    );
    expect(xml).toContain("</sitemapindex>");
    expect(xml).not.toContain("<sitemap>");
  });
});
