/**
 * Single source of truth for family <-> builder mapping behind the segmented
 * sitemap: a sitemap index at `/sitemap.xml` plus one child `<urlset>` per
 * route family at `/sitemaps/<family>.xml`. Both the index route and the
 * per-family child routes (added in a later unit) read `SITEMAP_FAMILIES`
 * rather than importing `lib/sitemap-routes.ts` builders directly, so the
 * route <-> builder mapping can never drift between the two route files.
 *
 * Child routes live at `/sitemaps/<family>.xml` — NOT `/sitemap/<family>.xml`
 * — because the singular form collides with Next's own `sitemap` metadata
 * file convention: `generateSitemaps()` produces routes shaped
 * `/sitemap/<id>.xml`, so reusing that path prefix for our hand-rolled routes
 * would be ambiguous with a feature Next itself owns.
 */
import type { MetadataRoute } from "next";
import {
  buildStaticRoutes,
  buildLearnRoutes,
  buildStateRoutes,
  buildOperatorRoutes,
  buildStakeholderRoutes,
  buildFacilityRoutes,
  buildStatusRoutes,
  buildMetroRoutes,
  buildCountyRoutes,
} from "@/lib/sitemap-routes";
import { siteConfig } from "@/lib/site";

/**
 * Family ids, in the same order as the old flat `app/sitemap.ts`'s
 * concatenation (static, learn, states, operators, stakeholders, facilities,
 * status, metros, counties) — so splitting into per-family child sitemaps is
 * a pure regrouping of the same URL set, not a reordering or a change in
 * composition.
 */
export const SITEMAP_FAMILY_IDS = [
  "static",
  "learn",
  "states",
  "operators",
  "stakeholders",
  "facilities",
  "status",
  "metros",
  "counties",
] as const;

export type SitemapFamilyId = (typeof SITEMAP_FAMILY_IDS)[number];

export interface SitemapFamily {
  id: SitemapFamilyId;
  build: () => Promise<MetadataRoute.Sitemap>;
}

/**
 * The full family registry. `lib/sitemap-families.test.ts` asserts this
 * references every `build*Routes` export in `lib/sitemap-routes.ts` exactly
 * once — adding a tenth builder there without adding a family here (or vice
 * versa) fails that test.
 */
export const SITEMAP_FAMILIES: readonly SitemapFamily[] = [
  { id: "static", build: buildStaticRoutes },
  { id: "learn", build: buildLearnRoutes },
  { id: "states", build: buildStateRoutes },
  { id: "operators", build: buildOperatorRoutes },
  { id: "stakeholders", build: buildStakeholderRoutes },
  { id: "facilities", build: buildFacilityRoutes },
  { id: "status", build: buildStatusRoutes },
  { id: "metros", build: buildMetroRoutes },
  { id: "counties", build: buildCountyRoutes },
];

/** Site-relative path for a family's child sitemap route. */
export function sitemapChildPath(id: SitemapFamilyId): string {
  return `/sitemaps/${id}.xml`;
}

/** Absolute URL for a family's child sitemap route. */
export function sitemapChildUrl(id: SitemapFamilyId): string {
  return `${siteConfig.url}${sitemapChildPath(id)}`;
}

/** Absolute URL of the top-level sitemap index. */
export const SITEMAP_INDEX_URL = `${siteConfig.url}/sitemap.xml`;
