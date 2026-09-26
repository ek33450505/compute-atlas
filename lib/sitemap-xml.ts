/**
 * Hand-rolled XML serializers for the segmented sitemap (sitemap index at
 * `/sitemap.xml` + one child `<urlset>` per route family at
 * `/sitemaps/<family>.xml`). Next.js has no `<sitemapindex>` support at all
 * (the string appears nowhere in `node_modules/next/dist`), and its
 * `generateSitemaps()` API would drop `/sitemap.xml` entirely in favor of
 * `/sitemap/<id>.xml` routes (verified against a probe app on Next 16.3.3) —
 * so both document types are serialized here instead of through Next's
 * metadata file convention.
 *
 * Both serializers are pure and deterministic: no `new Date()`, no
 * `Math.random`. Every dynamic value is passed through `escapeXml` before
 * interpolation.
 *
 * We emit no `<image:image>`/`<video:video>`/`<xhtml:link>` (alternates)
 * elements — none of the nine route builders in `lib/sitemap-routes.ts`
 * produce that data, so there are no branches to implement for it.
 */
import type { MetadataRoute } from "next";
import { escapeXml } from "@/lib/xml";

const SITEMAP_XMLNS = "http://www.sitemaps.org/schemas/sitemap/0.9";

export interface SitemapIndexEntry {
  loc: string;
  lastModified?: Date | string;
}

/**
 * `Date` -> ISO 8601 string; a pre-formatted string passes through unchanged.
 * Shared by both serializers below.
 */
function formatLastModified(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Serializes one `<url>` block. Field order — `<loc>`, `<lastmod>`,
 * `<changefreq>`, `<priority>` — matches what Next's own metadata-file
 * serializer produces (read at
 * `node_modules/next/dist/build/webpack/loaders/metadata/resolve-route-data.js`,
 * function `resolveSitemap`), so replacing `app/sitemap.ts` with this
 * hand-rolled path preserves today's output semantics. Each optional field is
 * emitted only when present; `priority: 0` is a valid, falsy-but-present
 * number and MUST still be emitted, hence the explicit `typeof === "number"`
 * check rather than a truthiness check. `lastModified`, by contrast, IS
 * checked with a truthy test — matching `resolveSitemap` itself — so an
 * empty-string `lastModified` is treated as absent and emits no `<lastmod>`
 * tag. Today's builders only ever pass a `Date` (always truthy), so this is
 * unreachable in practice, but `<lastmod></lastmod>` is invalid sitemap
 * content and the wrong failure mode if that ever changes.
 *
 * Deliberate difference from Next: Next interpolates `<loc>` raw (unescaped).
 * We escape it, because facility/operator/stakeholder slugs can originate
 * from user-contributed or discovery-pipeline data and nothing upstream
 * guarantees they're already XML-safe.
 */
function buildUrlBlock(entry: MetadataRoute.Sitemap[number]): string {
  const fields: string[] = [`    <loc>${escapeXml(entry.url)}</loc>`];

  if (entry.lastModified) {
    fields.push(
      `    <lastmod>${escapeXml(formatLastModified(entry.lastModified))}</lastmod>`
    );
  }
  if (entry.changeFrequency !== undefined) {
    fields.push(`    <changefreq>${escapeXml(entry.changeFrequency)}</changefreq>`);
  }
  if (typeof entry.priority === "number") {
    fields.push(`    <priority>${escapeXml(String(entry.priority))}</priority>`);
  }

  return ["  <url>", ...fields, "  </url>"].join("\n");
}

/**
 * Serializes a Next `MetadataRoute.Sitemap` array into a `<urlset>` document
 * for one sitemap family's child route. An empty `entries` array yields a
 * well-formed `<urlset>` with zero `<url>` children, not an empty string.
 */
export function buildUrlsetXml(entries: MetadataRoute.Sitemap): string {
  const urlBlocks = entries.map(buildUrlBlock);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${SITEMAP_XMLNS}">`,
    ...urlBlocks,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * Serializes one `<sitemap>` block for the sitemap index. `<lastmod>` is
 * omitted when the child has no known `lastModified`.
 */
function buildSitemapBlock(entry: SitemapIndexEntry): string {
  const fields: string[] = [`    <loc>${escapeXml(entry.loc)}</loc>`];

  if (entry.lastModified !== undefined) {
    fields.push(
      `    <lastmod>${escapeXml(formatLastModified(entry.lastModified))}</lastmod>`
    );
  }

  return ["  <sitemap>", ...fields, "  </sitemap>"].join("\n");
}

/**
 * Serializes the top-level `/sitemap.xml` sitemap index: one `<sitemap>`
 * entry per child family route. An empty `children` array yields a
 * well-formed `<sitemapindex>` with zero `<sitemap>` children, not an empty
 * string.
 */
export function buildSitemapIndexXml(children: SitemapIndexEntry[]): string {
  const sitemapBlocks = children.map(buildSitemapBlock);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sitemapindex xmlns="${SITEMAP_XMLNS}">`,
    ...sitemapBlocks,
    "</sitemapindex>",
    "",
  ].join("\n");
}
