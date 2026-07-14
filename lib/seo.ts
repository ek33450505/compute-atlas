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
