import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectSitemapUrlsByFamily,
  decodeXml,
  familyFromChildUrl,
  isSitemapIndex,
  parseLocs,
} from "@/lib/sitemap-urls";

// ---------------------------------------------------------------------------
// Test helpers for collectSitemapUrlsByFamily — mirrors scripts/indexnow.test.ts's
// stubFetch/jsonResponse/sitemapXml shapes so the two suites read consistently,
// without sharing test-only code across a lib/script boundary.
// ---------------------------------------------------------------------------
function stubFetch(impl: (input: string) => unknown) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(status: number, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => body,
  };
}

function sitemapIndexXml(children: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...children.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`),
    "</sitemapindex>",
  ].join("\n");
}

function urlsetXml(urls: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `<url><loc>${u}</loc></url>`),
    "</urlset>",
  ].join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe("collectSitemapUrlsByFamily", () => {
  // -------------------------------------------------------------------------
  // Guards on the INDEX document itself — previously covered only
  // accidentally (via collectSitemapUrls's own empty-list check in
  // scripts/indexnow.test.ts), which does not exercise this function's own
  // "not an index" / "zero children" checks at all. scripts/index-census.ts
  // is a second caller that gets no such accidental cover, so these are
  // tested directly here.
  // -------------------------------------------------------------------------

  it("throws, naming the URL, when indexUrl is not a sitemap index", async () => {
    const indexUrl = "https://www.compute-atlas.com/sitemaps/static.xml";
    stubFetch(() => {
      throw new Error("must not fetch — indexXml was already provided");
    });
    const notAnIndex = urlsetXml(["https://www.compute-atlas.com/"]);

    await expect(collectSitemapUrlsByFamily(indexUrl, notAnIndex)).rejects.toThrow(indexUrl);
    await expect(collectSitemapUrlsByFamily(indexUrl, notAnIndex)).rejects.toThrow(
      /not a sitemap INDEX/
    );
  });

  it("throws when the index has zero <sitemap> children", async () => {
    const indexUrl = "https://www.compute-atlas.com/sitemap.xml";
    stubFetch(() => {
      throw new Error("must not fetch — indexXml was already provided");
    });

    await expect(collectSitemapUrlsByFamily(indexUrl, sitemapIndexXml([]))).rejects.toThrow(
      /zero <sitemap> children/
    );
  });

  it("fetches indexUrl itself when indexXml is not provided (fetch-fallback path)", async () => {
    const indexUrl = "https://www.compute-atlas.com/sitemap.xml";
    const childUrl = "https://www.compute-atlas.com/sitemaps/static.xml";
    const spy = stubFetch(async (input) => {
      if (input === indexUrl) return jsonResponse(200, sitemapIndexXml([childUrl]));
      if (input === childUrl) {
        return jsonResponse(200, urlsetXml(["https://www.compute-atlas.com/"]));
      }
      throw new Error(`unexpected fetch: ${input}`);
    });

    const results = await collectSitemapUrlsByFamily(indexUrl);

    expect(results).toEqual([
      { family: "static", sitemapUrl: childUrl, urls: ["https://www.compute-atlas.com/"] },
    ]);
    expect(spy.mock.calls.map((call) => call[0])).toEqual([indexUrl, childUrl]);
  });

  it("throws when a child sitemap is itself a sitemap index (nesting unsupported)", async () => {
    const indexUrl = "https://www.compute-atlas.com/sitemap.xml";
    const nestedUrl = "https://www.compute-atlas.com/sitemaps/nested.xml";
    stubFetch(async (input) => {
      if (input === nestedUrl) {
        return jsonResponse(
          200,
          sitemapIndexXml(["https://www.compute-atlas.com/sitemaps/deeper.xml"])
        );
      }
      throw new Error(`unexpected fetch: ${input}`);
    });

    await expect(
      collectSitemapUrlsByFamily(indexUrl, sitemapIndexXml([nestedUrl]))
    ).rejects.toThrow(/sitemap INDEX/);
  });

  it("throws, naming the family, when a child sitemap has zero <loc> entries", async () => {
    const indexUrl = "https://www.compute-atlas.com/sitemap.xml";
    const countiesUrl = "https://www.compute-atlas.com/sitemaps/counties.xml";
    stubFetch(async (input) => {
      if (input === countiesUrl) return jsonResponse(200, urlsetXml([]));
      throw new Error(`unexpected fetch: ${input}`);
    });

    await expect(
      collectSitemapUrlsByFamily(indexUrl, sitemapIndexXml([countiesUrl]))
    ).rejects.toThrow(/counties/);
  });

  // -------------------------------------------------------------------------
  // Origin rebasing — the fix. Every <loc> in the index is an absolute
  // PRODUCTION URL; fetching it verbatim breaks this function against any
  // non-production indexUrl (e.g. a local build serving the real index).
  // -------------------------------------------------------------------------

  it("fetches children from the origin the index was fetched from, not the <loc> origin", async () => {
    const indexUrl = "http://localhost:3999/sitemap.xml";
    const staticLoc = "https://www.compute-atlas.com/sitemaps/static.xml";
    const facilitiesLoc = "https://www.compute-atlas.com/sitemaps/facilities.xml";
    const indexXml = sitemapIndexXml([staticLoc, facilitiesLoc]);

    const spy = stubFetch(async (input) => {
      if (input === "http://localhost:3999/sitemaps/static.xml") {
        return jsonResponse(200, urlsetXml(["https://www.compute-atlas.com/"]));
      }
      if (input === "http://localhost:3999/sitemaps/facilities.xml") {
        return jsonResponse(200, urlsetXml(["https://www.compute-atlas.com/facilities/f-1"]));
      }
      throw new Error(`unexpected fetch: ${input}`);
    });

    await collectSitemapUrlsByFamily(indexUrl, indexXml);

    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3999/sitemaps/static.xml",
      "http://localhost:3999/sitemaps/facilities.xml",
    ]);
  });

  // The assertion that protects against the damaging failure mode: rebasing
  // the FETCH target must never leak into the harvested page URLs.
  it("keeps harvested page URLs on the PRODUCTION origin even though children were fetched from localhost", async () => {
    const indexUrl = "http://localhost:3999/sitemap.xml";
    const staticLoc = "https://www.compute-atlas.com/sitemaps/static.xml";
    const indexXml = sitemapIndexXml([staticLoc]);

    stubFetch(async (input) => {
      if (input === "http://localhost:3999/sitemaps/static.xml") {
        return jsonResponse(
          200,
          urlsetXml(["https://www.compute-atlas.com/", "https://www.compute-atlas.com/table"])
        );
      }
      throw new Error(`unexpected fetch: ${input}`);
    });

    const [result] = await collectSitemapUrlsByFamily(indexUrl, indexXml);

    expect(result.urls).toEqual([
      "https://www.compute-atlas.com/",
      "https://www.compute-atlas.com/table",
    ]);
    expect(result.urls.every((u) => u.startsWith("https://www.compute-atlas.com/"))).toBe(true);
    expect(result.urls.some((u) => u.startsWith("http://localhost"))).toBe(false);
  });

  it("is a byte-identical no-op when the index and its children share an origin (production)", async () => {
    const indexUrl = "https://www.compute-atlas.com/sitemap.xml";
    const staticLoc = "https://www.compute-atlas.com/sitemaps/static.xml";
    const indexXml = sitemapIndexXml([staticLoc]);

    const spy = stubFetch(async (input) => {
      if (input === staticLoc) return jsonResponse(200, urlsetXml(["https://www.compute-atlas.com/"]));
      throw new Error(`unexpected fetch: ${input}`);
    });

    const [result] = await collectSitemapUrlsByFamily(indexUrl, indexXml);

    expect(spy.mock.calls[0][0]).toBe(staticLoc);
    expect(result.sitemapUrl).toBe(staticLoc);
  });

  it("rebases a child <loc> whose path does not start with /sitemaps/", async () => {
    const indexUrl = "http://localhost:3999/sitemap.xml";
    const childLoc = "https://www.compute-atlas.com/legacy/other-family.xml";
    const indexXml = sitemapIndexXml([childLoc]);

    const spy = stubFetch(async (input) => {
      if (input === "http://localhost:3999/legacy/other-family.xml") {
        return jsonResponse(200, urlsetXml(["https://www.compute-atlas.com/x"]));
      }
      throw new Error(`unexpected fetch: ${input}`);
    });

    const [result] = await collectSitemapUrlsByFamily(indexUrl, indexXml);

    expect(spy.mock.calls[0][0]).toBe("http://localhost:3999/legacy/other-family.xml");
    expect(result.family).toBe("other-family");
  });
});
