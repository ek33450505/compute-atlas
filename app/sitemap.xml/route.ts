import type { MetadataRoute } from "next";
import { buildSitemapIndexXml, type SitemapIndexEntry } from "@/lib/sitemap-xml";
import { SITEMAP_FAMILIES, sitemapChildUrl } from "@/lib/sitemap-families";

export const revalidate = 3600; // same window app/sitemap.ts used

// Mirrors what Next's own metadata-route serializer emitted for
// `/sitemap.xml` (CACHE_HEADERS.REVALIDATE in
// next/dist/build/webpack/loaders/next-metadata-route-loader.js) rather than
// the `s-maxage=3600` used by app/activity/feed.xml/route.ts. This route
// REPLACES a live Next-owned endpoint, so swapping the implementation must be
// header-neutral — it must not silently start edge-caching a page that
// wasn't edge-cached before.
const SITEMAP_HEADERS = {
  "Content-Type": "application/xml",
  "Cache-Control": "public, max-age=0, must-revalidate",
} as const;

/**
 * Latest `lastModified` among a family's own entries, or `undefined` if the
 * family produced zero entries, none of its entries carry one, or every
 * carried value is unparseable. Exported (alongside the default `GET`) so
 * `app/sitemap.xml/route.test.ts` can exercise it directly. Not moved to
 * `lib/sitemap-families.ts` — that file is under concurrent review and this
 * only serves the sitemap index's per-child `<lastmod>`.
 *
 * A value that parses to `Invalid Date` is skipped via
 * `Number.isNaN(value.getTime())`, not accepted: a route builder's
 * `lastModified` traces back to `lastUpdated`, which `facilitySchema`
 * validates only as `z.string().min(4)` — never for parseability. Without
 * this guard, an unparseable FIRST entry would be accepted as `max`
 * unconditionally, and every later comparison (`x > NaN` is always `false`)
 * would leave it there — surfacing as an Invalid Date whose `.toISOString()`
 * throws inside `buildSitemapIndexXml`, crashing the entire `/sitemap.xml`
 * index over one bad record.
 */
export function maxEntryLastModified(entries: MetadataRoute.Sitemap): Date | undefined {
  let max: Date | undefined;
  for (const entry of entries) {
    if (entry.lastModified === undefined) continue;
    const value =
      entry.lastModified instanceof Date ? entry.lastModified : new Date(entry.lastModified);
    if (Number.isNaN(value.getTime())) continue;
    if (max === undefined || value.getTime() > max.getTime()) {
      max = value;
    }
  }
  return max;
}

export async function GET(): Promise<Response> {
  const children: SitemapIndexEntry[] = await Promise.all(
    SITEMAP_FAMILIES.map(async ({ id, build }) => {
      const entries = await build();
      return {
        loc: sitemapChildUrl(id),
        lastModified: maxEntryLastModified(entries),
      };
    })
  );

  return new Response(buildSitemapIndexXml(children), { headers: SITEMAP_HEADERS });
}
