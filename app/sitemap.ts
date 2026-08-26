import type { MetadataRoute } from "next";
import { getAllFacilities, getStates, getOperators, operatorSlug } from "@/lib/data";
import { stateSlugFromCode } from "@/lib/us-states";
import { STATUS_ORDER } from "@/lib/status";
import { METROS } from "@/lib/metros";
import { GLOSSARY_TOPICS } from "@/lib/glossary";
import { siteConfig } from "@/lib/site";
import type { Facility } from "@/lib/schema";

export const revalidate = 3600;

/**
 * Most recent `lastUpdated` among the given facilities, as a `Date` — used
 * as a hub's `lastModified` so it reflects real data freshness instead of
 * "now" on every rebuild. Falls back to the current time only if the group
 * is empty (shouldn't happen: callers derive groups from the same facility
 * list they filter).
 */
function maxLastUpdated(facilities: Facility[]): Date {
  if (facilities.length === 0) return new Date();
  const timestamps = facilities.map((f) => new Date(f.lastUpdated).getTime());
  return new Date(Math.max(...timestamps));
}

/**
 * Stable `lastModified` for genuinely static editorial pages (/about, /api,
 * /contribute, /support) that have no underlying dataset to derive freshness
 * from — using `new Date()` here would churn exactly like the dataset-backed
 * routes did (see buildStaticRoutes below). Bump by hand only when a page's
 * content meaningfully changes, never on every sitemap regeneration.
 */
const STATIC_PAGE_LAST_MODIFIED = new Date("2026-08-26T00:00:00Z");

/**
 * Builds the list of static route entries for the sitemap.
 *
 * Previously hardcoded `lastModified: new Date()` on every entry. Since this
 * file sets `revalidate = 3600`, that meant every static route — aggregate
 * pages included — advertised a brand-new lastmod every hour, forever,
 * which trains crawlers to discount the lastmod signal site-wide (including
 * on facility routes where it's accurate). Aggregate/dataset-backed routes
 * now use the dataset's real max `lastUpdated` via `maxLastUpdated` (the
 * same helper buildStateRoutes/buildOperatorRoutes use); genuinely static
 * editorial pages use `STATIC_PAGE_LAST_MODIFIED` instead.
 *
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildStaticRoutes(): Promise<MetadataRoute.Sitemap> {
  const facilities = await getAllFacilities();
  const datasetLastModified = maxLastUpdated(facilities);

  return [
    {
      url: siteConfig.url,
      lastModified: datasetLastModified,
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${siteConfig.url}/map`,
      lastModified: datasetLastModified,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${siteConfig.url}/table`,
      lastModified: datasetLastModified,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${siteConfig.url}/states`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/operators`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/power`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/crypto`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/ai`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/rankings`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/opposition`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/stats`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${siteConfig.url}/about`,
      lastModified: STATIC_PAGE_LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${siteConfig.url}/api`,
      lastModified: STATIC_PAGE_LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${siteConfig.url}/explore`,
      lastModified: datasetLastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${siteConfig.url}/activity`,
      lastModified: datasetLastModified,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${siteConfig.url}/contribute`,
      lastModified: STATIC_PAGE_LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${siteConfig.url}/support`,
      lastModified: STATIC_PAGE_LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}

/**
 * Builds facility route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildFacilityRoutes(): Promise<MetadataRoute.Sitemap> {
  const facilities = await getAllFacilities();
  return facilities.map((f) => ({
    url: `${siteConfig.url}/facilities/${f.id}`,
    lastModified: new Date(f.lastUpdated),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));
}

/**
 * Builds per-state route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildStateRoutes(): Promise<MetadataRoute.Sitemap> {
  const [codes, facilities] = await Promise.all([getStates(), getAllFacilities()]);
  return codes.map((code) => {
    const stateFacilities = facilities.filter((f) => f.location.state === code);
    return {
      url: `${siteConfig.url}/states/${stateSlugFromCode(code)}`,
      lastModified: maxLastUpdated(stateFacilities),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    };
  });
}

/**
 * Builds per-operator route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildOperatorRoutes(): Promise<MetadataRoute.Sitemap> {
  const [names, facilities] = await Promise.all([getOperators(), getAllFacilities()]);
  return names.map((name) => {
    const operatorFacilities = facilities.filter((f) => f.operator === name);
    return {
      url: `${siteConfig.url}/operators/${operatorSlug(name)}`,
      lastModified: maxLastUpdated(operatorFacilities),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    };
  });
}

/**
 * Builds the /status index + 5 per-status route entries for the sitemap.
 * `lastModified` uses the whole dataset's max `lastUpdated` (not a
 * per-status max like buildStateRoutes/buildOperatorRoutes) — each status
 * page's grid can include any facility whose status last changed, so the
 * page as a whole is only as fresh as the dataset's most recent update.
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildStatusRoutes(): Promise<MetadataRoute.Sitemap> {
  const facilities = await getAllFacilities();
  const lastModified = maxLastUpdated(facilities);
  return [
    {
      url: `${siteConfig.url}/status`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...STATUS_ORDER.map((status) => ({
      url: `${siteConfig.url}/status/${status}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}

/**
 * Builds the /metros index + 27 per-metro route entries for the sitemap.
 * Structurally mirrors buildStatusRoutes: `lastModified` uses the whole
 * dataset's max `lastUpdated` for every entry (index + all metros), kept
 * identical to its status-lens sibling rather than computing a per-metro
 * max. Exported separately so it can be unit-tested without Next.js.
 */
export async function buildMetroRoutes(): Promise<MetadataRoute.Sitemap> {
  const facilities = await getAllFacilities();
  const lastModified = maxLastUpdated(facilities);
  return [
    {
      url: `${siteConfig.url}/metros`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...METROS.map((m) => ({
      url: `${siteConfig.url}/metros/${m.slug}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}

/**
 * Builds the /learn index + 5 per-topic route entries for the sitemap.
 * `GLOSSARY_TOPICS` (lib/glossary.ts) is a static content registry, but the
 * rendered pages are NOT static: each one interpolates live dataset figures
 * (the stat row and the dataset-grounded paragraph in app/learn/[topic]/
 * page.tsx), so the page a crawler sees changes when the dataset changes.
 * `lastModified` therefore derives from the dataset's real max `lastUpdated`,
 * exactly like buildStatusRoutes/buildMetroRoutes — not `new Date()`, which
 * would re-stamp "now" on every hourly regeneration and churn the same way
 * buildStaticRoutes used to. Exported separately so it can be unit-tested
 * without Next.js.
 */
export async function buildLearnRoutes(): Promise<MetadataRoute.Sitemap> {
  const facilities = await getAllFacilities();
  const lastModified = maxLastUpdated(facilities);
  return [
    {
      url: `${siteConfig.url}/learn`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...GLOSSARY_TOPICS.map((topic) => ({
      url: `${siteConfig.url}/learn/${topic.slug}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [
    staticRoutes,
    learnRoutes,
    stateRoutes,
    operatorRoutes,
    facilityRoutes,
    statusRoutes,
    metroRoutes,
  ] = await Promise.all([
    buildStaticRoutes(),
    buildLearnRoutes(),
    buildStateRoutes(),
    buildOperatorRoutes(),
    buildFacilityRoutes(),
    buildStatusRoutes(),
    buildMetroRoutes(),
  ]);
  return [
    ...staticRoutes,
    ...learnRoutes,
    ...stateRoutes,
    ...operatorRoutes,
    ...facilityRoutes,
    ...statusRoutes,
    ...metroRoutes,
  ];
}
