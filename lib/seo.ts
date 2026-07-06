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
