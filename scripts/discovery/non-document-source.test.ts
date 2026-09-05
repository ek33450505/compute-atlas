import { describe, it, expect } from "vitest";

import { isNonDocumentSource } from "./non-document-source";

describe("isNonDocumentSource", () => {
  it("matches an ArcGIS REST FeatureServer URL — the 307-facility energy.utility citation", () => {
    expect(
      isNonDocumentSource({
        url: "https://gis.example-utility.org/arcgis/rest/services/Territory/FeatureServer/0/query",
      })
    ).toBe(true);
  });

  it("matches an ArcGIS REST MapServer URL on an arbitrary county GIS host", () => {
    expect(
      isNonDocumentSource({
        url: "https://maps.example-county.gov/arcgis/rest/services/Parcels/MapServer/2",
      })
    ).toBe(true);
  });

  it("matches /MapServer/ or /FeatureServer/ case-insensitively, without the arcgis/rest/services segment", () => {
    expect(isNonDocumentSource({ url: "https://example.com/gis/MAPSERVER/0" })).toBe(true);
    expect(isNonDocumentSource({ url: "https://example.com/gis/featureserver/1" })).toBe(true);
  });

  it("matches Esri's hosted item-details viewer page (arcgis.com/home/item.html)", () => {
    expect(
      isNonDocumentSource({ url: "https://www.arcgis.com/home/item.html?id=abc123def456" })
    ).toBe(true);
  });

  it("matches the Nominatim geocoder host", () => {
    expect(
      isNonDocumentSource({ url: "https://nominatim.openstreetmap.org/search?q=some+facility&format=json" })
    ).toBe(true);
  });

  it("matches any URL carrying ArcGIS REST's f=json format switch, case-insensitively", () => {
    expect(isNonDocumentSource({ url: "https://example.com/gis/query?where=1=1&f=json" })).toBe(true);
    expect(isNonDocumentSource({ url: "https://example.com/gis/query?where=1=1&f=JSON" })).toBe(true);
  });

  it("matches on kind === 'osm' regardless of URL shape", () => {
    expect(isNonDocumentSource({ url: "https://www.openstreetmap.org/way/12345", kind: "osm" })).toBe(true);
  });

  it("does NOT match an ordinary article/press URL", () => {
    expect(
      isNonDocumentSource({ url: "https://www.example-news.com/2026/09/01/new-data-center-announced", kind: "press" })
    ).toBe(false);
  });

  it("does NOT match a PDF filing URL", () => {
    expect(
      isNonDocumentSource({ url: "https://www.sec.gov/Archives/edgar/data/12345/filing.pdf", kind: "filing" })
    ).toBe(false);
  });

  // Recorded FALSE POSITIVE regression — see the doc-comment's "FALSE
  // POSITIVE THIS FUNCTION MUST NEVER PRODUCE" section. An earlier `/search/`
  // substring pattern over-matched these two real, readable TDLR permit
  // pages purely because "Search" appears in that site's own URL routing.
  it("does NOT match the recorded TDLR permit false positives", () => {
    expect(isNonDocumentSource({ url: "https://www.tdlr.texas.gov/TABS/Search/Project/TABS2025023484" })).toBe(false);
    expect(isNonDocumentSource({ url: "https://www.tdlr.texas.gov/TABS/Search/Print/TABS2023019972" })).toBe(false);
  });

  it("returns false (never throws) for an unparseable URL", () => {
    expect(isNonDocumentSource({ url: "not a url at all" })).toBe(false);
  });
});
