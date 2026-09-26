import { describe, it, expect } from "vitest";
import type { MetadataRoute } from "next";
import * as sitemapRoutes from "@/lib/sitemap-routes";
import {
  SITEMAP_FAMILIES,
  SITEMAP_FAMILY_IDS,
  sitemapChildPath,
  sitemapChildUrl,
  SITEMAP_INDEX_URL,
} from "@/lib/sitemap-families";
import { siteConfig } from "@/lib/site";

type RouteBuilder = () => Promise<MetadataRoute.Sitemap>;

/**
 * Every `build*Routes` function exported by lib/sitemap-routes.ts, by name.
 * Discovered by naming convention + `typeof === "function"` rather than a
 * hardcoded list, so this test breaks if a builder is added there without
 * updating SITEMAP_FAMILIES.
 */
function getBuilderExports(): Array<[string, RouteBuilder]> {
  return Object.entries(sitemapRoutes).filter(
    (entry): entry is [string, RouteBuilder] =>
      /^build[A-Za-z]+Routes$/.test(entry[0]) && typeof entry[1] === "function"
  );
}

describe("SITEMAP_FAMILIES coverage", () => {
  it("references every build*Routes export exactly once, by function identity", () => {
    const builderExports = getBuilderExports();
    const registeredBuilders = SITEMAP_FAMILIES.map((f) => f.build);

    for (const [name, fn] of builderExports) {
      const referenceCount = registeredBuilders.filter(
        (registered) => registered === fn
      ).length;
      expect(
        referenceCount,
        `${name} should be referenced exactly once by SITEMAP_FAMILIES, found ${referenceCount}`
      ).toBe(1);
    }
  });

  it("references no builder outside lib/sitemap-routes.ts's build*Routes exports", () => {
    const exportedFns = new Set<RouteBuilder>(getBuilderExports().map(([, fn]) => fn));
    for (const family of SITEMAP_FAMILIES) {
      expect(
        exportedFns.has(family.build),
        `SITEMAP_FAMILIES entry "${family.id}" does not reference a build*Routes export`
      ).toBe(true);
    }
  });
});

describe("SITEMAP_FAMILIES set equality (regrouping, not pruning)", () => {
  it("the union of family URLs equals the union of direct builder URLs, with no cross-family duplicates", async () => {
    const familyUrlLists = await Promise.all(
      SITEMAP_FAMILIES.map((f) => f.build().then((r) => r.map((e) => e.url)))
    );
    const builderExports = getBuilderExports();
    const directUrlLists = await Promise.all(
      builderExports.map(([, fn]) => fn().then((r) => r.map((e) => e.url)))
    );

    const familyUrls = familyUrlLists.flat();
    const directUrls = directUrlLists.flat();
    const familySet = new Set(familyUrls);
    const directSet = new Set(directUrls);

    const onlyInFamilies = [...new Set(familyUrls.filter((u) => !directSet.has(u)))];
    const onlyInDirect = [...new Set(directUrls.filter((u) => !familySet.has(u)))];

    expect(onlyInFamilies, "family output contains a URL no direct builder produced").toEqual(
      []
    );
    expect(
      onlyInDirect,
      "a direct builder's URL is missing from every family (dropped, not just regrouped)"
    ).toEqual([]);

    const seenIn = new Map<string, string>();
    familyUrlLists.forEach((urls, i) => {
      const familyId = SITEMAP_FAMILIES[i].id;
      for (const url of urls) {
        const priorFamily = seenIn.get(url);
        expect(
          priorFamily,
          `${url} appears in both "${priorFamily}" and "${familyId}"`
        ).toBeUndefined();
        seenIn.set(url, familyId);
      }
    });
  });

  // This is a FLOOR, not an expected value — GSC reports 2,959 URLs in
  // today's flat sitemap, but this test does not need updating as the
  // dataset grows. It exists to catch a family silently returning `[]`,
  // which the set-equality check above would NOT catch on its own if a bug
  // made both the family path and the direct-builder path collapse to the
  // same (wrong) empty result.
  it("totals more than 2900 URLs across all families", async () => {
    const familyResults = await Promise.all(SITEMAP_FAMILIES.map((f) => f.build()));
    const total = familyResults.reduce((sum, r) => sum + r.length, 0);
    expect(total).toBeGreaterThan(2900);
  });
});

describe("SITEMAP_FAMILY_IDS", () => {
  it("has no duplicate ids", () => {
    expect(new Set(SITEMAP_FAMILY_IDS).size).toBe(SITEMAP_FAMILY_IDS.length);
  });

  it("every id matches /^[a-z-]+$/", () => {
    for (const id of SITEMAP_FAMILY_IDS) {
      expect(id).toMatch(/^[a-z-]+$/);
    }
  });
});

describe("sitemapChildUrl / SITEMAP_INDEX_URL", () => {
  it("sitemapChildUrl is absolute and under siteConfig.url for every family id", () => {
    for (const id of SITEMAP_FAMILY_IDS) {
      const url = sitemapChildUrl(id);
      expect(url.startsWith(siteConfig.url)).toBe(true);
      expect(url).toBe(`${siteConfig.url}${sitemapChildPath(id)}`);
    }
  });

  it("SITEMAP_INDEX_URL is absolute and under siteConfig.url", () => {
    expect(SITEMAP_INDEX_URL.startsWith(siteConfig.url)).toBe(true);
    expect(SITEMAP_INDEX_URL).toBe(`${siteConfig.url}/sitemap.xml`);
  });
});
