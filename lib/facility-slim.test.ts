import { describe, it, expect } from "vitest";

import { facilitiesSchema, type Facility } from "@/lib/schema";
import { toMapFacility, toMapPoint, toMiniMapFacility, toPopupSummary, toTableRow } from "@/lib/facility-slim";

// A record with every field the projector may carry, one per facility type.
const SOURCES = [
  { url: "https://example.com/a", label: "A", retrievedAt: "2026-01-01", kind: "other" },
  { url: "https://example.com/b", label: "B", retrievedAt: "2026-01-02", kind: "other" },
];

const BASE = {
  id: "acme-1",
  name: "Acme One",
  operator: "Acme",
  status: "operational",
  confidence: "confirmed",
  location: {
    lat: 31.123456789,
    lon: -97.987654321,
    city: "Waco",
    county: "McLennan",
    street: "1 Main St",
    postalCode: "76701",
    state: "TX",
    precision: "representative_multi_site",
    multiSite: { states: ["TX", "OK"], siteCountNote: "many" },
  },
  capacityMw: { operational: 10, planned: 20 },
  poweredBy: "grid",
  announcedDate: "2025",
  statusHistory: [],
  sources: SOURCES,
  lastUpdated: "2026-01-01",
  notes: "secret prose",
};

const FULL: Facility[] = facilitiesSchema.parse([
  { ...BASE, facilityType: "data_center", aiClassification: "confirmed" },
  {
    ...BASE,
    id: "acme-2",
    facilityType: "crypto_mining",
    aiClassification: "mixed_use",
    mining: { hashRateThPerS: 5, powerArrangement: "grid", hardwareType: "asic" },
    environmental: { carbonIntensityProxy: 3, carbonIntensityBasis: "estimated" },
  },
  { ...BASE, id: "acme-3", facilityType: "power_generation" },
]);

describe("toMapFacility", () => {
  // Adding a field to the map payload is a deliberate act: update this list.
  it("emits exactly the allow-listed keys", () => {
    const [dc, mining, power] = FULL.map(toMapFacility);
    const common = [
      "capacityMw",
      "confidence",
      "facilityType",
      "id",
      "location",
      "name",
      "operator",
      "sources",
      "status",
    ];
    expect(Object.keys(dc).sort()).toEqual([...common, "aiClassification"].sort());
    expect(Object.keys(mining).sort()).toEqual([...common, "environmental", "mining"].sort());
    expect(Object.keys(power).sort()).toEqual([...common].sort());
    expect(Object.keys(dc.location).sort()).toEqual(
      ["city", "lat", "lon", "multiSite", "precision", "state"].sort()
    );
    expect(Object.keys(dc.sources[0]).sort()).toEqual(["label", "url"]);
    if (mining.facilityType !== "crypto_mining") throw new Error("unreachable");
    expect(Object.keys(mining.mining ?? {}).sort()).toEqual(["hashRateThPerS", "powerArrangement"]);
    expect(Object.keys(mining.environmental ?? {})).toEqual(["carbonIntensityProxy"]);
    expect(dc.location.multiSite).toEqual({ states: ["TX", "OK"] });
  });

  it("keeps only the first source and drops heavy fields", () => {
    const json = JSON.stringify(FULL.map(toMapFacility));
    expect(json).not.toContain("https://example.com/b");
    for (const k of ["statusHistory", "notes", "secret prose", "county", "street", "postalCode"]) {
      expect(json).not.toContain(k);
    }
  });

  it("rounds marker coordinates to 4 decimal places", () => {
    const { location } = toMapFacility(FULL[0]);
    expect(location.lat).toBe(31.1235);
    expect(location.lon).toBe(-97.9877);
  });

  it("projects an empty source list instead of throwing on a record with no sources", () => {
    // DB reads are not re-validated, so this shape can reach the projector.
    const noSources = { ...FULL[0], sources: [] } as Facility;
    expect(toMapFacility(noSources).sources).toEqual([]);
  });

  it("omits precision when exact and optional fields when absent", () => {
    const [plain] = facilitiesSchema.parse([
      {
        ...BASE,
        facilityType: "data_center",
        location: { lat: 1, lon: 2, state: "TX", precision: "exact" },
        capacityMw: undefined,
      },
    ]);
    const slim = toMapFacility(plain);
    expect(Object.keys(slim.location).sort()).toEqual(["lat", "lon", "state"]);
    expect("capacityMw" in slim).toBe(false);
    expect("aiClassification" in slim).toBe(false);
  });
});

describe("toTableRow", () => {
  // Adding a field to the /table payload is a deliberate act: update this list.
  it("emits exactly the allow-listed keys", () => {
    const [dc, mining, power] = FULL.map(toTableRow);
    const common = [
      "capacityMw",
      "confidence",
      "facilityType",
      "id",
      "lastUpdated",
      "location",
      "name",
      "operator",
      "status",
    ];
    expect(Object.keys(dc).sort()).toEqual([...common, "aiClassification"].sort());
    expect(Object.keys(mining).sort()).toEqual([...common, "aiClassification"].sort());
    expect(Object.keys(power).sort()).toEqual([...common].sort());
    expect(Object.keys(dc.location).sort()).toEqual(["city", "state"]);
  });

  it("carries no coordinates", () => {
    const json = JSON.stringify(FULL.map(toTableRow));
    expect(json).not.toMatch(/"lat"|"lon"/);
    expect(json).not.toContain("31.12");
  });

  it("drops fields the table does not render", () => {
    const json = JSON.stringify(FULL.map(toTableRow));
    for (const k of [
      "statusHistory",
      "community",
      "notes",
      "street",
      "postalCode",
      "sources",
      "sourceCount",
      "announcedDate",
      "county",
      "precision",
      "multiSite",
      "offtaker",
      "mining",
      "environmental",
    ]) {
      expect(json).not.toContain(`"${k}"`);
    }
    expect(json).not.toContain("secret prose");
    expect(json).not.toContain("example.com");
  });
});

describe("toMiniMapFacility", () => {
  it("emits only name, status and the location the map needs", () => {
    const m = toMiniMapFacility(FULL[0]);
    expect(Object.keys(m).sort()).toEqual(["location", "name", "status"]);
    expect(Object.keys(m.location).sort()).toEqual(["city", "lat", "lon", "state"]);
    const json = JSON.stringify(m);
    for (const k of ["statusHistory", "notes", "secret prose", "retrievedAt", "postalCode", "street", "county", "sources", "capacityMw"]) {
      expect(json).not.toContain(k);
    }
  });

  it("omits city when absent", () => {
    const noCity: Record<string, unknown> = { ...BASE.location };
    delete noCity.city;
    const [f] = facilitiesSchema.parse([{ ...BASE, location: noCity, facilityType: "power_generation" }]);
    expect("city" in toMiniMapFacility(f).location).toBe(false);
  });
});

// The map/table payload size budgets are per-record brotli ceilings measured on
// the full dataset (a small fixture compresses differently per record, so the
// same ceilings would be meaningless there). They live in
// facility-slim.dataset.test.ts.

describe("toMapPoint", () => {
  // Adding a field to the public map payload is a deliberate act: update this list.
  it("emits exactly the allow-listed keys", () => {
    for (const f of FULL) {
      const p = toMapPoint(f);
      expect(Object.keys(p).sort()).toEqual(["facilityType", "id", "location", "status"]);
      expect(Object.keys(p.location).sort()).toEqual(["lat", "lon", "state"]);
    }
  });

  it("serializes no identifying text", () => {
    const json = JSON.stringify(FULL.map(toMapPoint));
    for (const k of ["Acme", "Waco", "name", "operator", "city", "capacityMw", "sources", "precision"]) {
      expect(json).not.toContain(k);
    }
  });

  it("rounds coordinates to 2 decimals", () => {
    const { location } = toMapPoint(FULL[0]);
    expect(location.lat).toBe(31.12);
    expect(location.lon).toBe(-97.99);
    const dp = (n: number) => (String(n).split(".")[1] ?? "").length;
    expect(dp(location.lat)).toBeLessThanOrEqual(2);
    expect(dp(location.lon)).toBeLessThanOrEqual(2);
  });
});

describe("toMapPoint rounding", () => {
  it("rounds ties away from zero for negative and positive coordinates", () => {
    const at = (lat: number, lon: number) =>
      toMapPoint({ ...FULL[0], location: { ...FULL[0].location, lat, lon } } as Facility).location;
    expect(at(40.125, -97.125)).toMatchObject({ lat: 40.13, lon: -97.13 });
    expect(at(-40.125, 97.125)).toMatchObject({ lat: -40.13, lon: 97.13 });
  });
});

describe("toPopupSummary", () => {
  it("copies siting fields one by one, so an extra siting key never leaks", () => {
    const siting = {
      nearestWater: { name: "Creek", kind: "river", distanceMi: 1.2, lat: 31.1 },
      nearestTransmission: { voltageKv: 345, distanceMi: 2.5, lon: -97.1 },
    } as unknown as Parameters<typeof toPopupSummary>[1];
    const s = toPopupSummary(FULL[0], siting);
    expect(s.nearestWater).toEqual({ name: "Creek", kind: "river", distanceMi: 1.2 });
    expect(s.nearestTransmission).toEqual({ voltageKv: 345, distanceMi: 2.5 });
    expect(JSON.stringify(s)).not.toMatch(/"lat"|"lon"/);
  });

  it("carries lastUpdated and the source count, and no other unexpected keys", () => {
    const s = toPopupSummary(FULL[0]);
    expect(s.lastUpdated).toBe("2026-01-01");
    expect(s.sourceCount).toBe(FULL[0].sources.length);
    expect(Object.keys(s).sort()).toEqual(
      [
        "aiClassification", "capacityMw", "city", "confidence", "facilityType", "id",
        "lastUpdated", "multiSiteStates", "name", "operator", "precision", "source",
        "sourceCount", "state", "status",
      ].sort()
    );
  });

  it("pins the exact key set for a crypto-mining record", () => {
    const s = toPopupSummary(FULL[1]);
    expect(Object.keys(s).sort()).toEqual(
      [
        "aiClassification", "capacityMw", "carbonIntensityProxy", "city", "confidence",
        "facilityType", "id", "lastUpdated", "mining", "multiSiteStates", "name", "operator",
        "precision", "source", "sourceCount", "state", "status",
      ].sort()
    );
    expect(Object.keys(s.mining ?? {}).sort()).toEqual(["hashRateThPerS", "powerArrangement"]);
  });

  it("pins the exact key set for a record with siting context, nested keys included", () => {
    const siting = {
      nearestWater: { name: "Creek", kind: "river", distanceMi: 1.2, lat: 31.1 },
      nearestTransmission: { voltageKv: 345, distanceMi: 2.5, lon: -97.1 },
    } as unknown as Parameters<typeof toPopupSummary>[1];
    const s = toPopupSummary(FULL[0], siting);
    expect(Object.keys(s).sort()).toEqual(
      [
        "aiClassification", "capacityMw", "city", "confidence", "facilityType", "id",
        "lastUpdated", "multiSiteStates", "name", "nearestTransmission", "nearestWater",
        "operator", "precision", "source", "sourceCount", "state", "status",
      ].sort()
    );
    expect(Object.keys(s.nearestWater ?? {}).sort()).toEqual(["distanceMi", "kind", "name"]);
    expect(Object.keys(s.nearestTransmission ?? {}).sort()).toEqual(["distanceMi", "voltageKv"]);
  });

  it("carries no coordinates", () => {
    const json = JSON.stringify(FULL.map((f) => toPopupSummary(f)));
    expect(json).not.toMatch(/"lat"|"lon"/);
    expect(json).not.toContain("31.12");
  });

  it("carries the fields the popup shows", () => {
    const s = toPopupSummary(FULL[0]);
    expect(s).toMatchObject({
      id: "acme-1",
      name: "Acme One",
      operator: "Acme",
      status: "operational",
      facilityType: "data_center",
      confidence: "confirmed",
      city: "Waco",
      state: "TX",
      multiSiteStates: ["TX", "OK"],
      precision: "representative_multi_site",
      capacityMw: { operational: 10, planned: 20 },
      aiClassification: "confirmed",
      source: { url: "https://example.com/a", label: "A" },
    });
    expect(JSON.stringify(s)).not.toContain("example.com/b");
    expect(JSON.stringify(s)).not.toContain("secret prose");
  });

  it("carries mining fields and carbon proxy for crypto sites", () => {
    const s = toPopupSummary(FULL[1]);
    expect(s.mining).toEqual({ hashRateThPerS: 5, powerArrangement: "grid" });
    expect(s.carbonIntensityProxy).toBe(3);
  });

  it("includes siting distances only when an entry is passed", () => {
    expect(toPopupSummary(FULL[0]).nearestWater).toBeUndefined();
    const s = toPopupSummary(FULL[0], {
      nearestWater: { name: "Brazos River", kind: "river", distanceMi: 1.2 },
      nearestTransmission: { voltageKv: 345, distanceMi: 0.4 },
      aquifer: { name: "x", rock: "y" },
    });
    expect(s.nearestWater).toEqual({ name: "Brazos River", kind: "river", distanceMi: 1.2 });
    expect(s.nearestTransmission).toEqual({ voltageKv: 345, distanceMi: 0.4 });
    expect(JSON.stringify(s)).not.toContain("aquifer");
  });

  it("omits precision when exact and handles a record with no sources", () => {
    const exact = facilitiesSchema.parse([
      { ...BASE, facilityType: "data_center", location: { lat: 1, lon: 2, state: "TX", precision: "exact" } },
    ])[0];
    expect("precision" in toPopupSummary(exact)).toBe(false);
    const none = { ...FULL[0], sources: [] } as Facility;
    expect(toPopupSummary(none).source).toBeUndefined();
  });
});
