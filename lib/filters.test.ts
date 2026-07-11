import { describe, it, expect } from "vitest";
import { filterFacilities, getFilterOptions } from "./filters";
import type { Facility, DataCenterFacility } from "@/lib/schema";

function makeFacility(
  overrides: Partial<DataCenterFacility> & {
    id: string;
    name: string;
    operator: string;
    status: Facility["status"];
    state: string;
    city?: string;
    capacityMw?: Facility["capacityMw"];
  }
): DataCenterFacility {
  const { state, city, capacityMw, ...rest } = overrides;
  return {
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 35, lon: -90, state, city, precision: "exact" },
    capacityMw,
    statusHistory: [],
    sources: [
      {
        url: "https://example.com",
        label: "Source",
        retrievedAt: "2024-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2024-01-01",
    ...rest,
  };
}

const facilityA = makeFacility({
  id: "a",
  name: "Alpha Center",
  operator: "AlphaCorp",
  status: "operational",
  state: "TN",
  city: "Memphis",
  capacityMw: { operational: 150 },
});

const facilityB = makeFacility({
  id: "b",
  name: "Beta Farm",
  operator: "BetaInc",
  status: "proposed",
  state: "TX",
  city: "Austin",
  capacityMw: { planned: 1200 },
});

const facilityC = makeFacility({
  id: "c",
  name: "Gamma Hub",
  operator: "AlphaCorp",
  status: "under_construction",
  state: "VA",
  city: "Reston",
  // no capacity
});

const allFacilities = [facilityA, facilityB, facilityC];

// ---------------------------------------------------------------------------
// Empty / omitted filters → return all
// ---------------------------------------------------------------------------
describe("filterFacilities — empty filters", () => {
  it("returns all when filters object is empty", () => {
    expect(filterFacilities(allFacilities, {})).toHaveLength(3);
  });

  it("returns all when statuses is an empty array", () => {
    expect(filterFacilities(allFacilities, { statuses: [] })).toHaveLength(3);
  });

  it("returns all when states is an empty array", () => {
    expect(filterFacilities(allFacilities, { states: [] })).toHaveLength(3);
  });

  it("returns all when minMw is 0", () => {
    expect(filterFacilities(allFacilities, { minMw: 0 })).toHaveLength(3);
  });

  it("returns all when query is empty string", () => {
    expect(filterFacilities(allFacilities, { query: "" })).toHaveLength(3);
  });

  it("returns all when query is only whitespace", () => {
    expect(filterFacilities(allFacilities, { query: "   " })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Status filter
// ---------------------------------------------------------------------------
describe("filterFacilities — statuses", () => {
  it("filters to a single matching status", () => {
    const result = filterFacilities(allFacilities, { statuses: ["operational"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("filters to multiple matching statuses", () => {
    const result = filterFacilities(allFacilities, {
      statuses: ["operational", "proposed"],
    });
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(["a", "b"]);
  });

  it("returns empty when no facilities match the status", () => {
    const result = filterFacilities(allFacilities, { statuses: ["cancelled"] });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// States filter
// ---------------------------------------------------------------------------
describe("filterFacilities — states", () => {
  it("filters by a single state", () => {
    const result = filterFacilities(allFacilities, { states: ["TN"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("filters by multiple states", () => {
    const result = filterFacilities(allFacilities, { states: ["TN", "VA"] });
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Operators filter
// ---------------------------------------------------------------------------
describe("filterFacilities — operators", () => {
  it("filters by operator — one match", () => {
    const result = filterFacilities(allFacilities, { operators: ["BetaInc"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("filters by operator — multiple facilities share an operator", () => {
    const result = filterFacilities(allFacilities, { operators: ["AlphaCorp"] });
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// MinMw filter
// ---------------------------------------------------------------------------
describe("filterFacilities — minMw", () => {
  it("includes facility at exactly the threshold", () => {
    const result = filterFacilities(allFacilities, { minMw: 150 });
    expect(result.map((f) => f.id).sort()).toEqual(["a", "b"]);
  });

  it("excludes facility below the threshold", () => {
    const result = filterFacilities(allFacilities, { minMw: 500 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("excludes facilities with no capacity when minMw > 0", () => {
    const result = filterFacilities(allFacilities, { minMw: 1 });
    // facilityC has no capacity, so it's excluded
    expect(result.map((f) => f.id)).not.toContain("c");
  });

  it("includes all when minMw is 0", () => {
    expect(filterFacilities(allFacilities, { minMw: 0 })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Query filter
// ---------------------------------------------------------------------------
describe("filterFacilities — query", () => {
  it("matches by name (case-insensitive)", () => {
    // "alpha center" uniquely matches facilityA's name; it does NOT match
    // facilityC's operator "AlphaCorp" which does not contain the word "center"
    const result = filterFacilities(allFacilities, { query: "alpha center" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("matches by operator", () => {
    const result = filterFacilities(allFacilities, { query: "betainc" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("matches by city", () => {
    const result = filterFacilities(allFacilities, { query: "reston" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c");
  });

  it("matches by state", () => {
    const result = filterFacilities(allFacilities, { query: "TX" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("returns empty when no match", () => {
    const result = filterFacilities(allFacilities, { query: "zzznomatch" });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined filters
// ---------------------------------------------------------------------------
describe("filterFacilities — combined", () => {
  it("ANDs status and state filters", () => {
    const result = filterFacilities(allFacilities, {
      statuses: ["operational"],
      states: ["TN"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("ANDs minMw with status filter — excludes no-capacity facility even if status matches", () => {
    const result = filterFacilities(allFacilities, {
      statuses: ["operational", "under_construction"],
      minMw: 100,
    });
    // facilityA: operational 150 MW ✓; facilityC: under_construction, no capacity ✗
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// getFilterOptions
// ---------------------------------------------------------------------------
describe("getFilterOptions", () => {
  it("returns only statuses present in the dataset, ordered by STATUS_ORDER", () => {
    const opts = getFilterOptions(allFacilities);
    // Present: operational, proposed, under_construction — in STATUS_ORDER sequence
    expect(opts.statuses).toEqual(["operational", "under_construction", "proposed"]);
  });

  it("returns unique states sorted A→Z", () => {
    const opts = getFilterOptions(allFacilities);
    expect(opts.states).toEqual(["TN", "TX", "VA"]);
  });

  it("returns unique operators sorted A→Z", () => {
    const opts = getFilterOptions(allFacilities);
    expect(opts.operators).toEqual(["AlphaCorp", "BetaInc"]);
  });

  it("returns maxMw as the highest capacity across facilities", () => {
    const opts = getFilterOptions(allFacilities);
    expect(opts.maxMw).toBe(1200);
  });

  it("returns maxMw = 0 when no facilities have capacity", () => {
    const opts = getFilterOptions([facilityC]);
    expect(opts.maxMw).toBe(0);
  });

  it("returns empty arrays and 0 for an empty dataset", () => {
    const opts = getFilterOptions([]);
    expect(opts.statuses).toEqual([]);
    expect(opts.states).toEqual([]);
    expect(opts.operators).toEqual([]);
    expect(opts.maxMw).toBe(0);
  });
});
