import { describe, it, expect } from "vitest";
import {
  INITIAL_VIEW_STATE,
  WIDE_AND_TALL_VIEWPORT_QUERY,
  buildMarkerLabel,
  computeFacilitiesBounds,
} from "@/lib/map";
import type { Facility } from "@/lib/schema";

// --- Fixtures ---

const facilityFull: Facility = {
  id: "test-colossus",
  name: "Colossus",
  operator: "xAI",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: {
    lat: 35.1495,
    lon: -90.049,
    city: "Memphis",
    state: "TN",
    precision: "exact",
  },
  capacityMw: { operational: 150, planned: 300 },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com/source",
      label: "Example Article",
      retrievedAt: "2024-01-01",
      kind: "press",
    },
  ],
  lastUpdated: "2024-01",
};

const facilityNoCapacity: Facility = {
  id: "test-proposed",
  name: "Proposed Hub",
  operator: "SomeOperator",
  status: "proposed",
  facilityType: "data_center",
  aiClassification: "likely",
  confidence: "rumored",
  location: {
    lat: 40.0,
    lon: -80.0,
    state: "PA",
    precision: "exact",
  },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com/source2",
      label: "Filing",
      retrievedAt: "2024-01-01",
      kind: "permit",
    },
  ],
  lastUpdated: "2024-01",
};

const facilityPlannedOnly: Facility = {
  ...facilityNoCapacity,
  id: "test-planned",
  name: "Under Construction Site",
  status: "under_construction",
  capacityMw: { planned: 500 },
};

/** Minimal facility fixture at a given [lon, lat] — only location matters for bounds tests. */
function at(lon: number, lat: number, id = `test-${lon},${lat}`): Facility {
  return {
    ...facilityNoCapacity,
    id,
    location: { ...facilityNoCapacity.location, lon, lat },
  };
}

// --- Tests ---

describe("INITIAL_VIEW_STATE", () => {
  it("centers on the contiguous US (longitude ≈ -98.5)", () => {
    expect(INITIAL_VIEW_STATE.longitude).toBeCloseTo(-98.5, 0);
  });

  it("centers on the contiguous US (latitude ≈ 39.5)", () => {
    expect(INITIAL_VIEW_STATE.latitude).toBeCloseTo(39.5, 0);
  });

  it("has a zoom level suitable for a continental US overview (3–5)", () => {
    expect(INITIAL_VIEW_STATE.zoom).toBeGreaterThanOrEqual(3);
    expect(INITIAL_VIEW_STATE.zoom).toBeLessThanOrEqual(5);
  });
});

describe("WIDE_AND_TALL_VIEWPORT_QUERY", () => {
  // MapFilterSubheader and FacilityMap's Tools column both default open/
  // expanded only when this query matches, so a landscape phone (wide but
  // short) stays collapsed instead of squeezing the map to ~half the
  // viewport. Consumer components each carry their own regression test
  // proving THEY query this exact exported value (not a hardcoded second
  // copy) — this block instead pins the value itself.
  it("requires a minimum width of 640px", () => {
    expect(WIDE_AND_TALL_VIEWPORT_QUERY).toContain("(min-width: 640px)");
  });

  it("requires a minimum height of 600px, so a viewport that's wide but short (e.g. a landscape phone) still fails", () => {
    expect(WIDE_AND_TALL_VIEWPORT_QUERY).toContain("(min-height: 600px)");
  });

  it("combines both terms with AND, so both must hold rather than either alone", () => {
    expect(WIDE_AND_TALL_VIEWPORT_QUERY).toBe(
      "(min-width: 640px) and (min-height: 600px)"
    );
  });
});

describe("buildMarkerLabel", () => {
  it("reads \"Type — Status — ST\"", () => {
    expect(buildMarkerLabel(facilityFull)).toBe("Data center — Operational — TN");
  });

  it("uses the human-readable labels, not raw enum values", () => {
    const label = buildMarkerLabel(facilityPlannedOnly);
    expect(label).not.toMatch(/data_center|crypto_mining|power_generation/);
  });

  it("carries no name, operator, city or capacity (the client does not hold them)", () => {
    const label = buildMarkerLabel(facilityFull);
    for (const leaked of ["Colossus", "xAI", "Memphis", "MW"]) {
      expect(label).not.toContain(leaked);
    }
  });
});

describe("computeFacilitiesBounds", () => {
  it("returns null for an empty array", () => {
    expect(computeFacilitiesBounds([])).toBeNull();
  });

  it("treats a single facility as coincident, centered on itself", () => {
    const result = computeFacilitiesBounds([at(-90, 35)]);
    expect(result).not.toBeNull();
    expect(result!.isCoincident).toBe(true);
    expect(result!.center).toEqual([-90, 35]);
    expect(result!.bounds).toEqual([
      [-90, 35],
      [-90, 35],
    ]);
  });

  it("computes bounds and center for two spread-out facilities", () => {
    const result = computeFacilitiesBounds([at(-100, 30), at(-80, 45)]);
    expect(result).not.toBeNull();
    expect(result!.isCoincident).toBe(false);
    expect(result!.bounds).toEqual([
      [-100, 30],
      [-80, 45],
    ]);
    expect(result!.center).toEqual([-90, 37.5]);
  });

  it("treats two facilities within 0.0005° of each other as coincident", () => {
    const result = computeFacilitiesBounds([
      at(-90, 35),
      at(-90.0005, 35.0005),
    ]);
    expect(result).not.toBeNull();
    expect(result!.isCoincident).toBe(true);
  });
});
