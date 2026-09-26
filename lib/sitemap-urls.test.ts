import { describe, it, expect } from "vitest";
import { decodeXml, isSitemapIndex, parseLocs, familyFromChildUrl } from "@/lib/sitemap-urls";

describe("decodeXml", () => {
  it("decodes the five predefined XML entities", () => {
    expect(decodeXml("&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp;")).toBe("<a> \"b\" 'c' &");
  });

  // &amp; is unescaped LAST — a double-escaped entity must survive as its
  // single-escaped form, not decode all the way down to a raw character.
  it("unescapes &amp; last, so a doubly-escaped entity does not over-decode", () => {
    expect(decodeXml("&amp;lt;")).toBe("&lt;");
  });

  it("passes through text with no entities unchanged", () => {
    expect(decodeXml("https://example.com/plain?a=1")).toBe("https://example.com/plain?a=1");
  });
});

describe("isSitemapIndex", () => {
  it("is true for a document with a <sitemapindex> root", () => {
    const xml =
      '<?xml version="1.0"?><sitemapindex xmlns="x"><sitemap><loc>a</loc></sitemap></sitemapindex>';
    expect(isSitemapIndex(xml)).toBe(true);
  });

  it("is false for a document with a <urlset> root", () => {
    const xml = '<?xml version="1.0"?><urlset xmlns="x"><url><loc>a</loc></url></urlset>';
    expect(isSitemapIndex(xml)).toBe(false);
  });
});

describe("parseLocs", () => {
  it("extracts every <loc> value in document order", () => {
    const xml = [
      '<urlset xmlns="x">',
      "<url><loc>https://example.com/a</loc></url>",
      "<url><loc>https://example.com/b</loc></url>",
      "</urlset>",
    ].join("\n");
    expect(parseLocs(xml)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("decodes an entity-encoded & inside a <loc>", () => {
    const xml = "<urlset><url><loc>https://example.com/table?a=1&amp;b=2</loc></url></urlset>";
    expect(parseLocs(xml)).toEqual(["https://example.com/table?a=1&b=2"]);
  });

  it("trims whitespace around a <loc> that spans multiple lines", () => {
    const xml = [
      "<urlset><url><loc>",
      "  https://example.com/multiline  ",
      "</loc></url></urlset>",
    ].join("\n");
    expect(parseLocs(xml)).toEqual(["https://example.com/multiline"]);
  });

  it("returns an empty array when there are no <loc> entries", () => {
    expect(parseLocs('<urlset xmlns="x"></urlset>')).toEqual([]);
  });
});

describe("familyFromChildUrl", () => {
  it("strips the path and .xml extension", () => {
    expect(familyFromChildUrl("https://www.compute-atlas.com/sitemaps/counties.xml")).toBe(
      "counties"
    );
  });

  it("is case-insensitive about the .xml extension", () => {
    expect(familyFromChildUrl("https://www.compute-atlas.com/sitemaps/counties.XML")).toBe(
      "counties"
    );
  });
});
