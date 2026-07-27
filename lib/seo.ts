import type { Facility } from "@/lib/schema";
import { siteConfig } from "@/lib/site";

export interface FacilityJsonLd {
  "@context": "https://schema.org";
  "@type": "Place";
  name: string;
  url: string;
  address: {
    "@type": "PostalAddress";
    addressCountry: "US";
    addressRegion: string;
    addressLocality?: string;
    streetAddress?: string;
    postalCode?: string;
  };
  geo: {
    "@type": "GeoCoordinates";
    latitude: number;
    longitude: number;
  };
}

/**
 * Builds a schema.org Place JSON-LD object for a facility.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildFacilityJsonLd(facility: Facility): FacilityJsonLd {
  const address: FacilityJsonLd["address"] = {
    "@type": "PostalAddress",
    addressCountry: "US",
    addressRegion: facility.location.state,
  };
  if (facility.location.city) {
    address.addressLocality = facility.location.city;
  }
  if (facility.location.street) {
    address.streetAddress = facility.location.street;
  }
  if (facility.location.postalCode) {
    address.postalCode = facility.location.postalCode;
  }

  return {
    "@context": "https://schema.org",
    "@type": "Place",
    name: facility.name,
    url: `${siteConfig.url}/facilities/${facility.id}`,
    address,
    geo: {
      "@type": "GeoCoordinates",
      latitude: facility.location.lat,
      longitude: facility.location.lon,
    },
  };
}

/**
 * Serializes a facility's JSON-LD to a string safe for dangerouslySetInnerHTML.
 * Escapes `<` as `<` so a field containing `</script>` cannot break out
 * of the enclosing script tag. Defense-in-depth: data is Zod-validated, but
 * escaping anyway per OWASP guidance.
 */
export function facilityJsonLdString(facility: Facility): string {
  return JSON.stringify(buildFacilityJsonLd(facility)).replace(/</g, "\\u003c");
}

export interface DatasetJsonLd {
  "@context": "https://schema.org";
  "@type": "Dataset";
  name: string;
  description: string;
  url: string;
  sameAs: string;
  keywords: string[];
  license: string;
  isAccessibleForFree: true;
  creator: {
    "@type": "Person";
    name: string;
    url: string;
  };
  publisher: {
    "@type": "Organization";
    name: string;
    url: string;
  };
  spatialCoverage: {
    "@type": "Place";
    name: string;
  };
  measurementTechnique: string;
  variableMeasured: string[];
  distribution: {
    "@type": "DataDownload";
    encodingFormat: string;
    contentUrl: string;
  }[];
  dateModified?: string;
}

/**
 * Builds a schema.org Dataset JSON-LD object describing the whole facility
 * dataset (not a single facility) — enables Google Dataset Search eligibility.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildDatasetJsonLd(opts: { dateModified?: string } = {}): DatasetJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Compute Atlas — U.S. Data Center & Compute Infrastructure Dataset",
    description: siteConfig.description,
    url: siteConfig.url,
    sameAs: siteConfig.repoUrl,
    keywords: [
      "data centers",
      "AI infrastructure",
      "hyperscale compute",
      "crypto mining",
      "power generation",
      "energy consumption",
      "water use",
      "subsidies",
      "United States",
    ],
    license: "https://creativecommons.org/licenses/by/4.0/",
    isAccessibleForFree: true,
    creator: { "@type": "Person", name: "Edward Kubiak", url: siteConfig.url },
    publisher: { "@type": "Organization", name: siteConfig.name, url: siteConfig.url },
    spatialCoverage: { "@type": "Place", name: "United States" },
    measurementTechnique:
      "Manual compilation from public primary sources (permit filings, ISO interconnection queues, subsidy and tax-abatement records, utility large-load filings, and local reporting); every record is source-cited.",
    variableMeasured: [
      "operator",
      "location",
      "capacity (MW)",
      "power source",
      "development status",
      "energy use",
      "water use",
      "subsidies",
      "jobs",
      "community reception",
    ],
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${siteConfig.url}/api/facilities`,
      },
    ],
    ...(opts.dateModified ? { dateModified: opts.dateModified } : {}),
  };
}

/**
 * Serializes the dataset's JSON-LD to a string safe for dangerouslySetInnerHTML.
 * Same `<` escaping as facilityJsonLdString — see that function's comment.
 */
export function datasetJsonLdString(opts: { dateModified?: string } = {}): string {
  return JSON.stringify(buildDatasetJsonLd(opts)).replace(/</g, "\\u003c");
}

export interface BreadcrumbJsonLd {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: {
    "@type": "ListItem";
    position: number;
    name: string;
    item?: string;
  }[];
}

/**
 * Builds a schema.org BreadcrumbList JSON-LD object from a crumb trail.
 * `position` is 1-based (`i + 1`). `url`, when present, is a site-relative
 * path resolved to an absolute URL under `siteConfig.url`; a crumb with no
 * `url` (conventionally the current page — the last crumb) omits `item`
 * per schema.org's BreadcrumbList guidance for the current page.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildBreadcrumbJsonLd(
  crumbs: { name: string; url?: string }[]
): BreadcrumbJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      ...(crumb.url ? { item: `${siteConfig.url}${crumb.url}` } : {}),
    })),
  };
}

/**
 * Serializes a breadcrumb trail's JSON-LD to a string safe for
 * dangerouslySetInnerHTML. Same `<` escaping as facilityJsonLdString — see
 * that function's comment.
 */
export function breadcrumbJsonLdString(
  crumbs: { name: string; url?: string }[]
): string {
  return JSON.stringify(buildBreadcrumbJsonLd(crumbs)).replace(/</g, "\\u003c");
}

export interface OrganizationJsonLd {
  "@context": "https://schema.org";
  "@type": "Organization";
  name: string;
  url: string;
  logo?: string;
  sameAs?: string[];
}

/**
 * Builds a schema.org Organization JSON-LD object describing Compute Atlas
 * itself — aids Google's Knowledge Graph / entity understanding of the site.
 * No logo asset exists yet, so `logo` is omitted rather than guessed.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildOrganizationJsonLd(): OrganizationJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    sameAs: [siteConfig.repoUrl],
  };
}

export interface WebSiteJsonLd {
  "@context": "https://schema.org";
  "@type": "WebSite";
  name: string;
  url: string;
  description: string;
  publisher?: {
    "@type": "Organization";
    name: string;
    url: string;
  };
}

/**
 * Builds a schema.org WebSite JSON-LD object. Deliberately omits a
 * SearchAction/sitelinks-searchbox — the site has no `?q=` GET search
 * endpoint, and a fake one would misrepresent search capability to Google.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildWebSiteJsonLd(): WebSiteJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.description,
    publisher: { "@type": "Organization", name: siteConfig.name, url: siteConfig.url },
  };
}

/**
 * Serializes the site-wide Organization + WebSite JSON-LD as a single
 * `@graph` document, so one script tag carries both nodes. Injected in the
 * root layout (every page) — separate from the homepage's Dataset node,
 * which describes the data, not the site.
 * Same `<` escaping as facilityJsonLdString — see that function's comment.
 */
export function siteJsonLdString(): string {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [buildOrganizationJsonLd(), buildWebSiteJsonLd()],
  };
  return JSON.stringify(graph).replace(/</g, "\\u003c");
}

export interface ItemListJsonLd {
  "@context": "https://schema.org";
  "@type": "ItemList";
  itemListElement: {
    "@type": "ListItem";
    position: number;
    name: string;
    url: string;
  }[];
}

/**
 * Builds a schema.org ItemList JSON-LD object for a directory/hub page
 * (e.g. /states, /operators). `position` is 1-based (`i + 1`). Contract:
 * callers pass already-absolute `url`s (typically `${siteConfig.url}/...`);
 * this builder only assigns positions, it does not resolve relative paths.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildItemListJsonLd(
  items: { name: string; url: string }[]
): ItemListJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      url: item.url,
    })),
  };
}

/**
 * Serializes an ItemList's JSON-LD to a string safe for
 * dangerouslySetInnerHTML. Same `<` escaping as facilityJsonLdString — see
 * that function's comment.
 */
export function itemListJsonLdString(
  items: { name: string; url: string }[]
): string {
  return JSON.stringify(buildItemListJsonLd(items)).replace(/</g, "\\u003c");
}
