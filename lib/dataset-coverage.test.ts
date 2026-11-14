import { describe, expect, it } from "vitest";

import { computeCoverage, coverageMap, withDeltas } from "@/lib/dataset-coverage";
import { facilitySchema, type Facility } from "@/lib/schema";

const make = (over: Record<string, unknown>): Facility =>
  facilitySchema.parse({
    confidence: "confirmed",
    sources: [{ url: "https://example.com/a", label: "A", retrievedAt: "2026-11-01" }],
    lastUpdated: "2026-11-01",
    id: "fx",
    name: "Example Campus",
    operator: "Example Operator",
    status: "operational",
    location: { lat: 40, lon: -97.5, state: "NE" },
    facilityType: "data_center",
    ...over,
  });

const dc1 = make({ id: "dc-1", name: "Example Campus A", capacityMw: { operational: 100 } });
const dc2 = make({ id: "dc-2", name: "Example Campus B" });
const mine = make({
  id: "mine-1",
  name: "Example Mine C",
  facilityType: "crypto_mining",
  mining: { hashRateThPerS: 500 },
});
const FACILITIES = [dc1, dc2, mine];

const row = (rows: ReturnType<typeof computeCoverage>, key: string) => {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};

describe("computeCoverage", () => {
  it("counts records whose CSV cell is non-empty", () => {
    const rows = computeCoverage(FACILITIES, null);
    expect(row(rows, "capacityMw.operational").filled).toBe(1);
    expect(row(rows, "id")).toMatchObject({ filled: 3, applicable: 3 });
  });

  it("limits a type-specific column's applicable count to the matching records", () => {
    const rows = computeCoverage(FACILITIES, null);
    expect(row(rows, "mining.hashRateThPerS")).toEqual({ key: "mining.hashRateThPerS", filled: 1, applicable: 1 });
  });

  it("adds no join-key rows without siting context", () => {
    expect(computeCoverage(FACILITIES, null).some((r) => r.key.startsWith("joinKeys."))).toBe(false);
  });

  it("counts join keys by facility id, ignoring unknown ids and non-string values", () => {
    const rows = computeCoverage(FACILITIES, {
      "dc-1": { joinKeys: { countyFips: "31055", tractGeoid: "", egridSubregion: 7 } },
      "dc-2": { joinKeys: { countyFips: "31055", egridSubregion: "MROW" } },
      "mine-1": "not an object",
      "gone-1": { joinKeys: { countyFips: "99999" } },
    });
    expect(row(rows, "joinKeys.countyFips")).toMatchObject({ filled: 2, applicable: 3 });
    expect(row(rows, "joinKeys.tractGeoid").filled).toBe(0);
    expect(row(rows, "joinKeys.egridSubregion").filled).toBe(1);
  });
});

describe("coverageMap", () => {
  it("maps each key to its filled count", () => {
    expect(coverageMap([{ key: "a", filled: 2, applicable: 5 }])).toEqual({ a: 2 });
  });
});

describe("withDeltas", () => {
  const rows = [
    { key: "a", filled: 10, applicable: 12 },
    { key: "b", filled: 3, applicable: 12 },
  ];

  it("subtracts the previous count", () => {
    expect(withDeltas(rows, { a: 7, b: 5 }).map((r) => r.delta)).toEqual([3, -2]);
  });

  it("gives null for a key the previous edition lacks", () => {
    expect(withDeltas(rows, { a: 7 }).map((r) => r.delta)).toEqual([3, null]);
  });

  it("gives null everywhere for a previous value that is not a plain object", () => {
    for (const prev of [null, undefined, "x", 4, [1, 2]]) {
      expect(withDeltas(rows, prev).map((r) => r.delta)).toEqual([null, null]);
    }
  });

  it("gives null for a negative or non-integer previous count", () => {
    expect(withDeltas(rows, { a: -1, b: 2.5 }).map((r) => r.delta)).toEqual([null, null]);
  });
});
