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
 * family produced zero entries (or none of its entries carry one). Kept as a
 * small local helper rather than added to `lib/sitemap-families.ts` — that
 * file is under concurrent review and this only serves the sitemap index's
 * per-child `<lastmod>`.
 */
function maxEntryLastModified(entries: MetadataRoute.Sitemap): Date | undefined {
  let max: Date | undefined;
  for (const entry of entries) {
    if (entry.lastModified === undefined) continue;
    const value =
      entry.lastModified instanceof Date ? entry.lastModified : new Date(entry.lastModified);
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
