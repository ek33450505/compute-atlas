import { describe, it, expect } from "vitest";
import {
  buildFacilityJsonLd,
  facilityJsonLdString,
  buildDatasetJsonLd,
  datasetJsonLdString,
} from "@/lib/seo";
import type { Facility } from "@/lib/schema";

const baseFacility: Facility = {
  id: "test-facility-ny",
  name: "Test Datacenter",
  operator: "Acme Corp",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: {
    lat: 40.7128,
    lon: -74.006,
    city: "New York City",
    state: "NY",
    precision: "exact",
  },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com/source",
      label: "Example source",
      retrievedAt: "2025-01",
      kind: "press",
    },
  ],
  lastUpdated: "2025-01-01",
};

describe("buildFacilityJsonLd", () => {
  it("returns a valid Place shape with required fields", () => {
    const ld = buildFacilityJsonLd(baseFacility);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Place");
    expect(ld.name).toBe("Test Datacenter");
  });

  it("includes geo coordinates matching the facility location", () => {
    const ld = buildFacilityJsonLd(baseFacility);
    expect(ld.geo["@type"]).toBe("GeoCoordinates");
    expect(ld.geo.latitude).toBe(40.7128);
    expect(ld.geo.longitude).toBe(-74.006);
  });

  it("sets addressRegion to the facility state", () => {
    const ld = buildFacilityJsonLd(baseFacility);
    expect(ld.address.addressRegion).toBe("NY");
  });

  it("sets addressLocality when city is present", () => {
    const ld = buildFacilityJsonLd(baseFacility);
    expect(ld.address.addressLocality).toBe("New York City");
  });

  it("omits addressLocality when city is absent", () => {
    const noCity: Facility = {
      ...baseFacility,
      location: { ...baseFacility.location, city: undefined },
    };
    const ld = buildFacilityJsonLd(noCity);
    expect(ld.address.addressLocality).toBeUndefined();
  });

  it("sets addressCountry to US", () => {
    const ld = buildFacilityJsonLd(baseFacility);
    expect(ld.address.addressCountry).toBe("US");
  });

  it("builds a url under siteConfig.url", () => {
    const ld = buildFacilityJsonLd(baseFacility);
    expect(ld.url).toContain("/facilities/test-facility-ny");
    expect(ld.url).toMatch(/^https?:\/\//);
  });
});

describe("facilityJsonLdString", () => {
  it("returns a string with no raw < characters for a normal facility", () => {
    const str = facilityJsonLdString(baseFacility);
    expect(str).not.toContain("<");
  });

  it("escapes < as \\u003c and removes </script> when name contains script-injection payload", () => {
    const xssFacility: Facility = {
      ...baseFacility,
      name: "</script><x>",
    };
    const str = facilityJsonLdString(xssFacility);
    expect(str).toContain("\\u003c");
    expect(str).not.toContain("</script>");
  });

  it("produces valid JSON after escaping", () => {
    const xssFacility: Facility = {
      ...baseFacility,
      name: "</script><x>",
    };
    const str = facilityJsonLdString(xssFacility);
    expect(() => JSON.parse(str)).not.toThrow();
  });

  it("preserves the shape produced by buildFacilityJsonLd", () => {
    const str = facilityJsonLdString(baseFacility);
    const parsed = JSON.parse(str);
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(parsed["@type"]).toBe("Place");
    expect(parsed.geo.latitude).toBe(40.7128);
  });
});

describe("buildDatasetJsonLd", () => {
  it("returns a valid Dataset shape", () => {
    const ld = buildDatasetJsonLd();
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Dataset");
  });

  it("points distribution[0].contentUrl at the facilities API route", () => {
    const ld = buildDatasetJsonLd();
    expect(ld.distribution[0].contentUrl).toMatch(/\/api\/facilities$/);
  });

  it("sets license to the CC-BY-4.0 URL", () => {
    const ld = buildDatasetJsonLd();
    expect(ld.license).toBe("https://creativecommons.org/licenses/by/4.0/");
  });

  it("includes dateModified when provided", () => {
    const ld = buildDatasetJsonLd({ dateModified: "2026-07-01T00:00:00.000Z" });
    expect(ld.dateModified).toBe("2026-07-01T00:00:00.000Z");
  });

  it("omits dateModified when not provided", () => {
    const ld = buildDatasetJsonLd();
    expect(ld.dateModified).toBeUndefined();
  });
});

describe("datasetJsonLdString", () => {
  it("returns a string with no raw < characters", () => {
    const str = datasetJsonLdString();
    expect(str).not.toContain("<");
  });

  it("produces valid JSON that round-trips to a Dataset shape", () => {
    const str = datasetJsonLdString();
    const parsed = JSON.parse(str);
    expect(parsed["@type"]).toBe("Dataset");
    expect(parsed.distribution[0].contentUrl).toMatch(/\/api\/facilities$/);
  });
});
