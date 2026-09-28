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
  DATASET_DOI_URL,
} from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import type { Facility } from "@/lib/schema";

/**
 * Hostile input for the five `*JsonLdString` serializers' breakout assertions.
 *
 * Each serializer applies `JSON.stringify(...).replace(/</g, "\\u003c")`, so the
 * guarantee is that ZERO `<` survives — not merely that the literal `</script>`
 * doesn't. These tests used to assert `not.toContain("</script>")`, which a
 * mutation narrowing the replace to `/<\/script/g` passes while leaving
 * `<script src=…>`, `<!--` and `<svg onload=…>` free to break out of the
 * surrounding `<script type="application/ld+json">` block.
 *
 * `]]>` is here because it terminates a CDATA section; the `<` escape does not
 * neutralize it, so these tests assert only that it survives the round trip
 * intact rather than claiming it is defanged.
 */
const SCRIPT_BREAKOUT_PAYLOAD = '</script><script src="x"><!-- ]]> <svg onload=alert(1)>';

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

  // Measured 2026-09-15: the Place carried name/url/address/geo only, so a
  // retrieval model learned a pin existed and nothing about it. Every fact a
  // reader sees must now also be machine-extractable.
  describe("additionalProperty (the citable facts)", () => {
    const propsOf = (f: Facility) =>
      Object.fromEntries(
        (buildFacilityJsonLd(f).additionalProperty ?? []).map((p) => [
          p.name,
          p.value,
        ])
      );

    it("carries operator, status and facility type as PropertyValue entries", () => {
      const props = buildFacilityJsonLd(baseFacility).additionalProperty ?? [];
      expect(props.length).toBeGreaterThan(0);
      props.forEach((p) => expect(p["@type"]).toBe("PropertyValue"));

      const byName = propsOf(baseFacility);
      expect(byName["Operator"]).toBe("Acme Corp");
      expect(byName["Facility type"]).toBe("Data center");
    });

    it("uses the canonical STATUS_META label, not a retyped string", () => {
      // Mutation coverage: emitting the raw enum yields "operational" and
      // fails here. Guards against the structured data drifting from the
      // rendered page the way title/H1 once did.
      expect(propsOf(baseFacility)["Status"]).toBe("Operational");
    });

    it("tags capacity with the megawatt unit code, not a bare number", () => {
      const ld = buildFacilityJsonLd({
        ...baseFacility,
        capacityMw: { planned: 4500, operational: 120 },
      } as Facility);
      const planned = (ld.additionalProperty ?? []).find(
        (p) => p.name === "Planned capacity"
      );
      const operational = (ld.additionalProperty ?? []).find(
        (p) => p.name === "Operational capacity"
      );
      expect(planned).toMatchObject({ value: 4500, unitCode: "MAW", unitText: "MW" });
      expect(operational).toMatchObject({ value: 120, unitCode: "MAW" });
    });

    it("omits capacity, AI classification and energy entries when unset", () => {
      // Absent must mean absent — never an entry with an empty or
      // "undefined" value, which would read as a published fact.
      const names = (buildFacilityJsonLd(baseFacility).additionalProperty ?? []).map(
        (p) => p.name
      );
      expect(names).not.toContain("Planned capacity");
      expect(names).not.toContain("Operational capacity");
      expect(names).not.toContain("Energy source");
      expect(names).not.toContain("Utility");
      names.forEach((n) => expect(n).toBeTruthy());
    });

    it("maps the energy source through ENERGY_SOURCE_ENTRIES, not the raw enum", () => {
      const props = propsOf({
        ...baseFacility,
        energy: { source: "on_site_gas", utility: "Duke Energy" },
      } as Facility);
      expect(props["Energy source"]).toBe("On-site gas");
      expect(props["Utility"]).toBe("Duke Energy");
    });

    it("emits no AI classification for a power_generation facility", () => {
      // That arm of the discriminated union has no such field; the absence is
      // structural, so this must hold without a cast.
      const names = (
        buildFacilityJsonLd({
          ...baseFacility,
          facilityType: "power_generation",
          capacityMw: { operational: 800 },
        } as Facility).additionalProperty ?? []
      ).map((p) => p.name);
      expect(names).not.toContain("AI classification");
      expect(names).toContain("Operational capacity");
    });

    it("survives serialization through facilityJsonLdString", () => {
      const parsed = JSON.parse(
        facilityJsonLdString(baseFacility).replace(/\\u003c/g, "<")
      );
      expect(parsed.additionalProperty).toBeInstanceOf(Array);
      expect(parsed.additionalProperty[0]["@type"]).toBe("PropertyValue");
    });
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

  it("escapes every < as \\u003c when the name carries a script-breakout payload", () => {
    const xssFacility: Facility = {
      ...baseFacility,
      name: SCRIPT_BREAKOUT_PAYLOAD,
    };
    const str = facilityJsonLdString(xssFacility);
    expect(str).toContain("\\u003c");
    expect(str).not.toContain("<");
    // The escape must not corrupt the data it protects.
    expect(JSON.parse(str).name).toBe(SCRIPT_BREAKOUT_PAYLOAD);
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

  it("sets identifier to the resolvable Zenodo DOI", () => {
    const ld = buildDatasetJsonLd();
    expect(ld.identifier).toBe(DATASET_DOI_URL);
    expect(ld.identifier).toBe("https://doi.org/10.5281/zenodo.22284476");
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

  it("escapes every < as \\u003c when dateModified carries a script-breakout payload", () => {
    // `dateModified` is this serializer's only caller-supplied input — every
    // other value is a module constant — so it is the whole injectable surface.
    const str = datasetJsonLdString({ dateModified: SCRIPT_BREAKOUT_PAYLOAD });
    expect(str).toContain("\\u003c");
    expect(str).not.toContain("<");
    expect(JSON.parse(str).dateModified).toBe(SCRIPT_BREAKOUT_PAYLOAD);
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

  it("escapes every < as \\u003c when a crumb name carries a script-breakout payload", () => {
    const str = breadcrumbJsonLdString([
      { name: "Map", url: "/map" },
      { name: SCRIPT_BREAKOUT_PAYLOAD },
    ]);
    expect(str).toContain("\\u003c");
    expect(str).not.toContain("<");
    expect(JSON.parse(str).itemListElement[1].name).toBe(SCRIPT_BREAKOUT_PAYLOAD);
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
  /**
   * ⚠️ Honest limit: this serializer takes NO arguments — every value in the
   * graph comes from `siteConfig` module constants, none of which contain a
   * `<`. So there is nothing to inject, and this assertion CANNOT distinguish
   * "the `<` escape is applied" from "the escape was deleted": both produce a
   * `<`-free string. It pins the output invariant only. The escape itself is
   * pinned by the four sibling serializers' breakout cases, which do have an
   * injectable surface. Do not read a pass here as coverage of the escape.
   */
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

  it("sets numberOfItems to the element count for a multi-item list", () => {
    const ld = buildItemListJsonLd(ITEMS);
    expect(ld.numberOfItems).toBe(2);
    expect(ld.numberOfItems).toBe(ld.itemListElement.length);
  });

  it("sets numberOfItems to 0 for an empty list", () => {
    const ld = buildItemListJsonLd([]);
    expect(ld.numberOfItems).toBe(0);
  });

  it("sets numberOfItems to the element count for a single-item list", () => {
    const ld = buildItemListJsonLd([ITEMS[0]]);
    expect(ld.numberOfItems).toBe(1);
  });
});

describe("itemListJsonLdString", () => {
  it("returns a string with no raw < characters for a normal list", () => {
    const str = itemListJsonLdString([
      { name: "California", url: "https://www.compute-atlas.com/states/california" },
    ]);
    expect(str).not.toContain("<");
  });

  it("escapes every < as \\u003c when an item name carries a script-breakout payload", () => {
    const str = itemListJsonLdString([
      { name: SCRIPT_BREAKOUT_PAYLOAD, url: "https://www.compute-atlas.com/states/x" },
    ]);
    expect(str).toContain("\\u003c");
    expect(str).not.toContain("<");
    expect(JSON.parse(str).itemListElement[0].name).toBe(SCRIPT_BREAKOUT_PAYLOAD);
  });

  it("produces valid JSON that round-trips to an ItemList shape", () => {
    const str = itemListJsonLdString([
      { name: "California", url: "https://www.compute-atlas.com/states/california" },
    ]);
    const parsed = JSON.parse(str);
    expect(parsed["@type"]).toBe("ItemList");
    expect(parsed.itemListElement[0].position).toBe(1);
    expect(parsed.numberOfItems).toBe(1);
  });

  it("produces valid JSON for an empty array", () => {
    const str = itemListJsonLdString([]);
    const parsed = JSON.parse(str);
    expect(parsed.itemListElement).toEqual([]);
    expect(parsed.numberOfItems).toBe(0);
  });
});
