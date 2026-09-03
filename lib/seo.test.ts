import { describe, it, expect } from "vitest";
import {
  buildFacilityJsonLd,
  facilityJsonLdString,
  buildDatasetJsonLd,
  datasetJsonLdString,
  buildBreadcrumbJsonLd,
  breadcrumbJsonLdString,
  buildOrganizationJsonLd,
  buildWebSiteJsonLd,
  siteJsonLdString,
  buildItemListJsonLd,
  itemListJsonLdString,
} from "@/lib/seo";
import { siteConfig } from "@/lib/site";
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
      retrievedAt: "2025-01-01",
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

  it("sets streetAddress and postalCode when present", () => {
    const withStreet: Facility = {
      ...baseFacility,
      location: {
        ...baseFacility.location,
        street: "3801 Britton Road",
        postalCode: "76063",
      },
    };
    const ld = buildFacilityJsonLd(withStreet);
    expect(ld.address.streetAddress).toBe("3801 Britton Road");
    expect(ld.address.postalCode).toBe("76063");
  });

  it("omits streetAddress and postalCode when absent", () => {
    const ld = buildFacilityJsonLd(baseFacility);
    expect(ld.address.streetAddress).toBeUndefined();
    expect(ld.address.postalCode).toBeUndefined();
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

describe("buildBreadcrumbJsonLd", () => {
  const TRAIL = [
    { name: "Map", url: "/map" },
    { name: "New York", url: "/states/new-york" },
    { name: "Test Datacenter" },
  ];

  it("returns a valid BreadcrumbList shape", () => {
    const ld = buildBreadcrumbJsonLd(TRAIL);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("BreadcrumbList");
    expect(ld.itemListElement).toHaveLength(3);
  });

  it("assigns 1-based positions in trail order", () => {
    const ld = buildBreadcrumbJsonLd(TRAIL);
    expect(ld.itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(ld.itemListElement.map((i) => i.name)).toEqual([
      "Map",
      "New York",
      "Test Datacenter",
    ]);
  });

  it("resolves a crumb's url to an absolute URL under siteConfig.url", () => {
    const ld = buildBreadcrumbJsonLd(TRAIL);
    expect(ld.itemListElement[0].item).toBe(`${siteConfig.url}/map`);
    expect(ld.itemListElement[1].item).toBe(`${siteConfig.url}/states/new-york`);
  });

  it("omits item for a url-less (current-page) crumb", () => {
    const ld = buildBreadcrumbJsonLd(TRAIL);
    expect(ld.itemListElement[2]).not.toHaveProperty("item");
  });
});

describe("breadcrumbJsonLdString", () => {
  it("returns a string with no raw < characters for a normal trail", () => {
    const str = breadcrumbJsonLdString([
      { name: "Map", url: "/map" },
      { name: "Test Datacenter" },
    ]);
    expect(str).not.toContain("<");
  });

  it("escapes < as \\u003c and removes </script> when a crumb name contains script-injection payload", () => {
    const str = breadcrumbJsonLdString([
      { name: "Map", url: "/map" },
      { name: "</script><x>" },
    ]);
    expect(str).toContain("\\u003c");
    expect(str).not.toContain("</script>");
  });

  it("produces valid JSON that round-trips to a BreadcrumbList shape", () => {
    const str = breadcrumbJsonLdString([
      { name: "Map", url: "/map" },
      { name: "Test Datacenter" },
    ]);
    const parsed = JSON.parse(str);
    expect(parsed["@type"]).toBe("BreadcrumbList");
    expect(parsed.itemListElement[0].position).toBe(1);
    expect(parsed.itemListElement[0].item).toBe(`${siteConfig.url}/map`);
    expect(parsed.itemListElement[1]).not.toHaveProperty("item");
  });
});

describe("buildOrganizationJsonLd", () => {
  it("returns a valid Organization shape from siteConfig", () => {
    const ld = buildOrganizationJsonLd();
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Organization");
    expect(ld.name).toBe(siteConfig.name);
    expect(ld.url).toBe(siteConfig.url);
  });

  it("sets sameAs to the repo URL", () => {
    const ld = buildOrganizationJsonLd();
    expect(ld.sameAs).toEqual([siteConfig.repoUrl]);
  });

  it("omits logo (no asset exists yet)", () => {
    const ld = buildOrganizationJsonLd();
    expect(ld.logo).toBeUndefined();
  });
});

describe("buildWebSiteJsonLd", () => {
  it("returns a valid WebSite shape from siteConfig", () => {
    const ld = buildWebSiteJsonLd();
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("WebSite");
    expect(ld.name).toBe(siteConfig.name);
    expect(ld.url).toBe(siteConfig.url);
    expect(ld.description).toBe(siteConfig.description);
  });

  it("does not include a potentialAction/SearchAction", () => {
    const ld = buildWebSiteJsonLd();
    expect(ld).not.toHaveProperty("potentialAction");
  });

  it("sets publisher to an Organization referencing the site", () => {
    const ld = buildWebSiteJsonLd();
    expect(ld.publisher).toEqual({
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    });
  });
});

describe("siteJsonLdString", () => {
  it("returns a string with no raw < characters", () => {
    const str = siteJsonLdString();
    expect(str).not.toContain("<");
  });

  it("produces valid JSON with a top-level @graph containing Organization and WebSite", () => {
    const str = siteJsonLdString();
    const parsed = JSON.parse(str);
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(Array.isArray(parsed["@graph"])).toBe(true);
    expect(parsed["@graph"]).toHaveLength(2);
    expect(parsed["@graph"].map((node: { "@type": string }) => node["@type"])).toEqual([
      "Organization",
      "WebSite",
    ]);
  });
});

describe("buildItemListJsonLd", () => {
  const ITEMS = [
    { name: "California", url: "https://www.compute-atlas.com/states/california" },
    { name: "Texas", url: "https://www.compute-atlas.com/states/texas" },
  ];

  it("returns a valid ItemList shape", () => {
    const ld = buildItemListJsonLd(ITEMS);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("ItemList");
    expect(ld.itemListElement).toHaveLength(2);
  });

  it("assigns 1-based positions in array order", () => {
    const ld = buildItemListJsonLd(ITEMS);
    expect(ld.itemListElement.map((i) => i.position)).toEqual([1, 2]);
  });

  it("preserves name and url from each item", () => {
    const ld = buildItemListJsonLd(ITEMS);
    expect(ld.itemListElement[0]).toMatchObject({
      "@type": "ListItem",
      position: 1,
      name: "California",
      url: "https://www.compute-atlas.com/states/california",
    });
  });

  it("handles an empty array", () => {
    const ld = buildItemListJsonLd([]);
    expect(ld.itemListElement).toEqual([]);
  });
});

describe("itemListJsonLdString", () => {
  it("returns a string with no raw < characters for a normal list", () => {
    const str = itemListJsonLdString([
      { name: "California", url: "https://www.compute-atlas.com/states/california" },
    ]);
    expect(str).not.toContain("<");
  });

  it("escapes < as \\u003c and removes </script> when a name contains script-injection payload", () => {
    const str = itemListJsonLdString([
      { name: "</script><x>", url: "https://www.compute-atlas.com/states/x" },
    ]);
    expect(str).toContain("\\u003c");
    expect(str).not.toContain("</script>");
  });

  it("produces valid JSON that round-trips to an ItemList shape", () => {
    const str = itemListJsonLdString([
      { name: "California", url: "https://www.compute-atlas.com/states/california" },
    ]);
    const parsed = JSON.parse(str);
    expect(parsed["@type"]).toBe("ItemList");
    expect(parsed.itemListElement[0].position).toBe(1);
  });

  it("produces valid JSON for an empty array", () => {
    const str = itemListJsonLdString([]);
    const parsed = JSON.parse(str);
    expect(parsed.itemListElement).toEqual([]);
  });
});
