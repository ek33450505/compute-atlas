import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

import { facilitiesSchema, type Facility } from "@/lib/schema";
import { toMapFacility, toTableRow } from "@/lib/facility-slim";
import { facilitiesToCsv } from "@/lib/export";

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
        location: { lat: 1, lon: 2, state: "TX" },
        capacityMw: undefined,
      },
    ]);
    const slim = toMapFacility(plain);
    expect(Object.keys(slim.location).sort()).toEqual(["lat", "lon", "state"]);
    expect("capacityMw" in slim).toBe(false);
    expect("aiClassification" in slim).toBe(false);
  });
});

describe("map payload size budget", () => {
  // Measures brotli q5 of JSON.stringify(projected corpus), NOT the RSC wire
  // format; real wire bytes are measured post-deploy. Per-record so data
  // growth cannot trip it, while adding a field to the projection still does.
  // It is a corpus average: a field added to only a few records is diluted and
  // can slip under the ceiling. The allow-list test above is what catches that.
  // Measured 2026-10-21: 255,024 B / 2,745 records = 92.9 B per record
  // (full records: 495 B). Ceiling = measured x ~1.2. Mutation-tested:
  // projecting `sources: f.sources` gives ~194 B per record and fails.
  // The PERF-1 brief's 0.2 MB estimate used 3 dp coordinates; 4 dp costs the rest.
  const MAX_BR_BYTES_PER_RECORD = 112;

  it("brotli-compressed projection stays within the per-record ceiling", () => {
    const all = facilitiesSchema.parse(
      JSON.parse(readFileSync(join(process.cwd(), "data/facilities.json"), "utf8"))
    );
    const json = JSON.stringify(all.map(toMapFacility));
    const br = brotliCompressSync(Buffer.from(json), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    }).length;
    const perRecord = br / all.length;
    expect(
      perRecord,
      `map payload is ${br} B brotli (q5) over ${all.length} records = ${perRecord.toFixed(1)} B/record`
    ).toBeLessThanOrEqual(MAX_BR_BYTES_PER_RECORD);
  });
});

describe("toTableRow", () => {
  // Adding a field to the /table payload is a deliberate act: update this list.
  it("emits exactly the allow-listed keys", () => {
    const [dc, mining, power] = FULL.map(toTableRow);
    const common = [
      "capacityMw",
      "announcedDate",
      "confidence",
      "facilityType",
      "id",
      "lastUpdated",
      "location",
      "name",
      "operator",
      "sourceCount",
      "sources",
      "status",
    ];
    expect(Object.keys(dc).sort()).toEqual([...common, "aiClassification"].sort());
    expect(Object.keys(mining).sort()).toEqual(
      [...common, "aiClassification", "environmental", "mining"].sort()
    );
    expect(Object.keys(power).sort()).toEqual([...common].sort());
    expect(Object.keys(dc.location).sort()).toEqual(
      ["city", "county", "lat", "lon", "multiSite", "precision", "state"].sort()
    );
    expect(Object.keys(dc.sources[0]).sort()).toEqual(["label", "url"]);
  });

  it("carries the real source count and only the first source", () => {
    const row = toTableRow(FULL[0]);
    expect(row.sourceCount).toBe(2);
    expect(row.sources).toEqual([{ url: "https://example.com/a", label: "A" }]);
  });

  it("keeps full-precision coordinates for the CSV", () => {
    const { location } = toTableRow(FULL[0]);
    expect(location.lat).toBe(31.123456789);
    expect(location.lon).toBe(-97.987654321);
  });

  it("drops heavy fields", () => {
    const json = JSON.stringify(FULL.map(toTableRow));
    for (const k of ["statusHistory", "community", "notes", "secret prose", "street", "postalCode", "example.com/b"]) {
      expect(json).not.toContain(k);
    }
  });

  it("carries a power plant's offtaker and nothing else from generation", () => {
    const [plant] = facilitiesSchema.parse([
      {
        ...BASE,
        facilityType: "power_generation",
        generation: { offtaker: "Acme Cloud", fuel: "gas" },
      },
    ]);
    const row = toTableRow(plant);
    expect("generation" in row && row.generation).toEqual({ offtaker: "Acme Cloud" });
  });
});

describe("table CSV parity", () => {
  const all = facilitiesSchema.parse(
    JSON.parse(readFileSync(join(process.cwd(), "data/facilities.json"), "utf8"))
  );

  it("is byte-identical for full records and their TableRow projections (whole dataset)", () => {
    expect(facilitiesToCsv(all.map(toTableRow))).toBe(facilitiesToCsv(all));
  });

  it("is byte-identical for the fixture records, whose source counts differ from 1", () => {
    expect(facilitiesToCsv(FULL.map(toTableRow))).toBe(facilitiesToCsv(FULL));
    expect(facilitiesToCsv(FULL.map(toTableRow))).toContain(",2,https://example.com/a");
  });
});

describe("table payload size budget", () => {
  // Same method and caveats as the map budget above. Measured 2026-10-21:
  // 284,870 B / 2,745 records = 103.8 B per record (full records: 495 B,
  // 1,359,639 B). Ceiling = measured x ~1.2. Mutation-tested: projecting
  // `sources: f.sources` pushes it well past the ceiling.
  const MAX_BR_BYTES_PER_RECORD = 125;

  it("brotli-compressed projection stays within the per-record ceiling", () => {
    const all = facilitiesSchema.parse(
      JSON.parse(readFileSync(join(process.cwd(), "data/facilities.json"), "utf8"))
    );
    const json = JSON.stringify(all.map(toTableRow));
    const br = brotliCompressSync(Buffer.from(json), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    }).length;
    const perRecord = br / all.length;
    expect(
      perRecord,
      `table payload is ${br} B brotli (q5) over ${all.length} records = ${perRecord.toFixed(1)} B/record`
    ).toBeLessThanOrEqual(MAX_BR_BYTES_PER_RECORD);
  });
});
