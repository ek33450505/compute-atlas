import type { Facility } from "@/lib/schema";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";
import { STATUS_META } from "@/lib/status";
import { ENERGY_SOURCE_ENTRIES } from "@/lib/energy";

/**
 * Compute Atlas's Zenodo concept DOI, resolvable and always pointing at the
 * latest archived release. This is the single source for the DOI: the
 * `Dataset` JSON-LD `identifier` below and the visible citation text on
 * `app/api/page.tsx` and `app/data/page.tsx` all read it from here, so a
 * future Zenodo release (which mints a NEW DOI) is a one-line change and
 * cannot leave the structured data disagreeing with the rendered page.
 */
export const DATASET_DOI_URL = "https://doi.org/10.5281/zenodo.22284476";

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
  additionalProperty?: FacilityJsonLdProperty[];
}

/**
 * One `schema.org/PropertyValue` entry on a facility's `Place`.
 *
 * `additionalProperty` is the documented schema.org mechanism for facts a type
 * has no dedicated property for — `Place` has no `operator`, `status` or
 * `capacity`, and inventing those keys would emit invalid structured data.
 * Capacity entries also carry `unitCode: "MAW"` (the UN/CEFACT code for
 * megawatt) so a consumer never has to infer the unit from the name.
 */
export interface FacilityJsonLdProperty {
  "@type": "PropertyValue";
  name: string;
  value: string | number;
  unitCode?: "MAW";
  unitText?: "MW";
}

/** Human-readable label for a `facilityType`, matching the rendered page. */
const FACILITY_TYPE_LABELS: Record<Facility["facilityType"], string> = {
  data_center: "Data center",
  crypto_mining: "Crypto mining",
  power_generation: "Power generation",
};

/** Human-readable label for an `aiClassification` tier. */
const AI_CLASSIFICATION_LABELS: Record<"confirmed" | "likely" | "mixed_use", string> = {
  confirmed: "Confirmed AI-specific",
  likely: "Likely AI-specific",
  mixed_use: "Mixed use",
};

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

  // Every fact the project exists to publish lived only in prose until
  // 2026-09-15:
  // the Place carried name/url/address/geo, so a retrieval model learned that
  // a pin existed and nothing about it. These entries put the same facts a
  // reader sees into machine-extractable form. Labels are read from the
  // canonical maps (STATUS_META, ENERGY_SOURCE_ENTRIES) rather than retyped,
  // so the structured data cannot drift from the rendered page.
  const additionalProperty: FacilityJsonLdProperty[] = [
    { "@type": "PropertyValue", name: "Operator", value: facility.operator },
    {
      "@type": "PropertyValue",
      name: "Status",
      value: STATUS_META[facility.status].label,
    },
    {
      "@type": "PropertyValue",
      name: "Facility type",
      value: FACILITY_TYPE_LABELS[facility.facilityType],
    },
  ];

  if (facility.capacityMw?.operational !== undefined) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "Operational capacity",
      value: facility.capacityMw.operational,
      unitCode: "MAW",
      unitText: "MW",
    });
  }
  if (facility.capacityMw?.planned !== undefined) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "Planned capacity",
      value: facility.capacityMw.planned,
      unitCode: "MAW",
      unitText: "MW",
    });
  }
  // `aiClassification` is absent from the `power_generation` arm of the
  // discriminated union, so narrow on facilityType rather than casting — a
  // power plant has no AI classification by construction, not by omission.
  if (
    facility.facilityType !== "power_generation" &&
    facility.aiClassification
  ) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "AI classification",
      value: AI_CLASSIFICATION_LABELS[facility.aiClassification],
    });
  }
  if (facility.energy?.source) {
    const source = facility.energy.source;
    const label =
      ENERGY_SOURCE_ENTRIES.find((e) => e.key === source)?.label ?? source;
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "Energy source",
      value: label,
    });
  }
  if (facility.energy?.utility) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "Utility",
      value: facility.energy.utility,
    });
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
    additionalProperty,
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
  identifier: string;
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
 * `identifier` carries the resolvable Zenodo concept DOI, the field Google
 * Dataset Search and citation tooling key on.
 *
 * Deliberately omits `temporalCoverage`: it would need an honest start date
 * for the period the data covers, and nothing available to this builder
 * supplies one — `getDatasetEdition()` (`lib/dataset-edition.ts`) exposes
 * only `asOf`, a single point-in-time export timestamp, not a range. Add it
 * only when a real start date becomes available; don't invent one.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildDatasetJsonLd(opts: { dateModified?: string } = {}): DatasetJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Compute Atlas — U.S. Data Center & Compute Infrastructure Dataset",
    description: siteConfig.description,
    url: siteConfig.url,
    identifier: DATASET_DOI_URL,
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
    license: DATASET_LICENSE_URL,
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
  numberOfItems: number;
  itemListElement: {
    "@type": "ListItem";
    position: number;
    name: string;
    url: string;
  }[];
}

/**
 * Builds a schema.org ItemList JSON-LD object for a directory/hub page
 * (e.g. /states, /operators). `position` is 1-based (`i + 1`).
 * `numberOfItems` is derived from `items.length` — the same array
 * `itemListElement` is built from — so it can never drift from the actual
 * element count; there is no separate caller-supplied count to fall out of
 * sync. Contract: callers pass already-absolute `url`s (typically
 * `${siteConfig.url}/...`); this builder only assigns positions, it does not
 * resolve relative paths.
 * Pure function — unit-testable without any DOM or Next.js dependencies.
 */
export function buildItemListJsonLd(
  items: { name: string; url: string }[]
): ItemListJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    numberOfItems: items.length,
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
