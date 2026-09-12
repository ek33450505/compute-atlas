import type { MetadataRoute } from "next";
import {
  getAllFacilities,
  getStates,
  getOperators,
  operatorSlug,
  getStakeholders,
  getFacilitiesByMetro,
  getCounties,
  getFacilitiesByCounty,
} from "@/lib/data";
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
 * /contribute, /support, /contact, /access, /methodology) that have no
 * underlying dataset to derive freshness from — using `new Date()` here
 * would churn exactly like the dataset-backed routes did (see
 * buildStaticRoutes below). Bump by hand only when a page's content
 * meaningfully changes, never on every sitemap regeneration. Last bumped
 * 2026-09-03 to cover the /api Zenodo DOI update (2026-09-03) and the
 * /about + /methodology edits (2026-09-01).
 */
const STATIC_PAGE_LAST_MODIFIED = new Date("2026-09-03T00:00:00Z");

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
      url: `${siteConfig.url}/gaps`,
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
      url: `${siteConfig.url}/methodology`,
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
      url: `${siteConfig.url}/data`,
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
    {
      url: `${siteConfig.url}/contact`,
      lastModified: STATIC_PAGE_LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${siteConfig.url}/access`,
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
 * Minimum facility count for an operator hub to be SUBMITTED in the
 * sitemap. Measured 2026-09-08 against Google Search Console (90-day
 * window 2026-06-10 to 2026-09-08): 547 distinct operators, 403 of them
 * (74%) have exactly ONE facility. Those 403 single-facility hubs were
 * 19% of the 2,088-URL sitemap but produced only 1.24% of impressions and
 * 8 clicks in 90 days (index rate 32% vs 56% for multi-facility hubs),
 * while `/states/virginia` — high commercial intent — sat "Discovered -
 * currently not indexed, last crawled: Never": Google was rationing crawl
 * budget against a long tail of hubs that render only a masthead, two
 * generated sentences, progress bars pinned at 0%/100%, and one row
 * linking to the facility page they restate. This is a sitemap-submission
 * change only — the routes themselves stay live, crawlable, and
 * internally linked (deliberately NOT noindex), so the 129 single-facility
 * hubs that DO earn impressions keep them.
 */
export const MIN_FACILITIES_FOR_OPERATOR_SITEMAP = 2;

/**
 * Builds per-operator route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 * Operators with fewer than MIN_FACILITIES_FOR_OPERATOR_SITEMAP facilities
 * are omitted from submission — see the constant's doc comment for why.
 */
export async function buildOperatorRoutes(): Promise<MetadataRoute.Sitemap> {
  const [names, facilities] = await Promise.all([getOperators(), getAllFacilities()]);
  return names
    .map((name) => {
      const operatorFacilities = facilities.filter((f) => f.operator === name);
      return { name, operatorFacilities };
    })
    .filter(
      ({ operatorFacilities }) =>
        operatorFacilities.length >= MIN_FACILITIES_FOR_OPERATOR_SITEMAP
    )
    .map(({ name, operatorFacilities }) => ({
      url: `${siteConfig.url}/operators/${operatorSlug(name)}`,
      lastModified: maxLastUpdated(operatorFacilities),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
}

/**
 * Builds the /stakeholders index + per-person route entries for the
 * sitemap. Structurally mirrors buildOperatorRoutes above: `lastModified`
 * for each per-person entry is that person's OWN facilities' max
 * `lastUpdated` (not the whole dataset), because a stakeholder hub, like an
 * operator hub, only changes when one of THEIR facilities changes. The
 * index entry uses the whole dataset's max `lastUpdated` since `/stakeholders`
 * has no dedicated entry in buildStaticRoutes (unlike `/operators`).
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildStakeholderRoutes(): Promise<MetadataRoute.Sitemap> {
  const [people, facilities] = await Promise.all([getStakeholders(), getAllFacilities()]);
  return [
    {
      url: `${siteConfig.url}/stakeholders`,
      lastModified: maxLastUpdated(facilities),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    ...people.map((p) => {
      const personFacilities = facilities.filter((f) =>
        (f.stakeholders ?? []).some((s) => s.name === p.name)
      );
      return {
        url: `${siteConfig.url}/stakeholders/${p.slug}`,
        lastModified: maxLastUpdated(personFacilities),
        changeFrequency: "weekly" as const,
        priority: 0.5,
      };
    }),
  ];
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
 * The index entry's `lastModified` uses the whole dataset's max
 * `lastUpdated` (it genuinely reflects the whole set). Each per-metro
 * entry's `lastModified` is that metro's OWN facilities' max `lastUpdated`,
 * matching buildStateRoutes/buildOperatorRoutes — membership is determined
 * by `getFacilitiesByMetro` (lib/data.ts), the SAME helper
 * app/metros/[metro]/page.tsx uses to render the hub, so the sitemap and
 * the page can never disagree about which facilities belong to a metro.
 * (Contrast buildStatusRoutes, which deliberately keeps the whole-dataset
 * max for every entry: any facility's status change can alter any status
 * page, so a per-status max would be wrong there — that one must NOT be
 * changed to match this.) Exported separately so it can be unit-tested
 * without Next.js.
 *
 * The 28 loader calls below are ONE data load, not 28. `loadFacilities`
 * (lib/data.ts:179) is assigned once at module scope from a factory whose
 * body returns `reactCache(...)`, so the memoized function itself is stable
 * and dedupes per request. That the request scope exists here is not an
 * assumption: this same sitemap already depends on it for `unstable_cache`,
 * which lib/data.ts documents as requiring the Next.js request-scoped cache
 * context — if that scope were absent during sitemap generation, facility
 * caching would already be broken site-wide, and it is not. Checked
 * 2026-09-08 in response to a review concern; don't re-litigate without
 * re-reading those two lines.
 */
export async function buildMetroRoutes(): Promise<MetadataRoute.Sitemap> {
  const [facilities, metroFacilities] = await Promise.all([
    getAllFacilities(),
    Promise.all(METROS.map((m) => getFacilitiesByMetro(m.slug))),
  ]);
  const lastModified = maxLastUpdated(facilities);
  return [
    {
      url: `${siteConfig.url}/metros`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...METROS.map((m, i) => ({
      url: `${siteConfig.url}/metros/${m.slug}`,
      lastModified: maxLastUpdated(metroFacilities[i]),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}

/**
 * Minimum facility count for a county hub to be SUBMITTED in the sitemap.
 * Deliberately the same rule, for the same measured reason, as
 * MIN_FACILITIES_FOR_OPERATOR_SITEMAP above: of 636 tracked counties, 354
 * (56%) hold exactly ONE facility, and a single-facility hub renders only a
 * masthead, two generated sentences, a stat row, and one card linking to the
 * facility page it restates. Submitting all 636 would add a long tail of
 * near-duplicate URLs to the sitemap and ration crawl budget away from the
 * high-intent hubs — precisely the pattern GSC measured on operator hubs
 * (1.24% of impressions from 19% of the sitemap).
 *
 * This is a sitemap-SUBMISSION decision only. All 636 county routes stay
 * generated (app/counties/[county]/page.tsx generates static params for every
 * county), live, crawlable, and internally linked from /counties and from
 * each facility page's Location fact row. They are deliberately NOT `noindex`
 * — the operator precedent explicitly rejected that, so a single-facility
 * hub that does earn impressions keeps them.
 */
export const MIN_FACILITIES_FOR_COUNTY_SITEMAP = 2;

/**
 * Builds the /counties index + per-county route entries for the sitemap.
 * Structurally mirrors buildMetroRoutes above: the index entry's
 * `lastModified` uses the whole dataset's max `lastUpdated` (it genuinely
 * reflects the whole set), while each per-county entry uses that county's OWN
 * facilities' max `lastUpdated` — a county hub only changes when one of ITS
 * facilities changes. Membership comes from `getFacilitiesByCounty`
 * (lib/data.ts), the SAME helper app/counties/[county]/page.tsx uses to
 * render the hub, so the sitemap and the page can never disagree about which
 * facilities belong to a county.
 *
 * Counties below MIN_FACILITIES_FOR_COUNTY_SITEMAP are omitted from
 * submission — see that constant's doc comment for why, and for why their
 * routes nonetheless stay live and indexable.
 *
 * The per-county loader calls are ONE data load, not hundreds: `getCounties`
 * and `getFacilitiesByCounty` both read the shared `loadFacilities()` cache
 * and resolve against a per-array-identity memoized county index (lib/data.ts,
 * `buildCountyIndex`), so each call is an O(1) map lookup.
 *
 * That holds in production but NOT under vitest: lib/data.ts sets
 * `loadFacilities = loadFacilitiesUncached` when `process.env.VITEST` is set,
 * and that returns `[...list].sort(...)` — a fresh array identity per call —
 * so the WeakMap misses and the index rebuilds on every call in the suite.
 * Harmless at this size (~3s across the county tests), but the claim above is
 * about the deployed path only; do not cite it to explain a test timing.
 */
export async function buildCountyRoutes(): Promise<MetadataRoute.Sitemap> {
  const [facilities, counties] = await Promise.all([
    getAllFacilities(),
    getCounties(),
  ]);
  const submitted = counties.filter(
    (c) => c.count >= MIN_FACILITIES_FOR_COUNTY_SITEMAP
  );
  const countyFacilities = await Promise.all(
    submitted.map((c) => getFacilitiesByCounty(c.slug))
  );
  return [
    {
      url: `${siteConfig.url}/counties`,
      lastModified: maxLastUpdated(facilities),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...submitted.map((c, i) => ({
      url: `${siteConfig.url}/counties/${c.slug}`,
      lastModified: maxLastUpdated(countyFacilities[i]),
      changeFrequency: "weekly" as const,
      priority: 0.6,
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
    stakeholderRoutes,
    facilityRoutes,
    statusRoutes,
    metroRoutes,
    countyRoutes,
  ] = await Promise.all([
    buildStaticRoutes(),
    buildLearnRoutes(),
    buildStateRoutes(),
    buildOperatorRoutes(),
    buildStakeholderRoutes(),
    buildFacilityRoutes(),
    buildStatusRoutes(),
    buildMetroRoutes(),
    buildCountyRoutes(),
  ]);
  return [
    ...staticRoutes,
    ...learnRoutes,
    ...stateRoutes,
    ...operatorRoutes,
    ...stakeholderRoutes,
    ...facilityRoutes,
    ...statusRoutes,
    ...metroRoutes,
    ...countyRoutes,
  ];
}
