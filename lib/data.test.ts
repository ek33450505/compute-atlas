import { describe, it, expect } from "vitest";
import {
  getAllFacilities,
  getFacilityById,
  getStates,
  getOperators,
  getStatusCounts,
  getStats,
  getCivicCoverage,
  getTopStates,
  getTopOperators,
  getAiClassificationCounts,
  getConfidenceCounts,
} from "@/lib/data";
import { facilitySchema, aiClassificationEnum, confidenceEnum } from "@/lib/schema";

describe("getAllFacilities", () => {
  it("returns a non-empty array including known seed ids", () => {
    const facilities = getAllFacilities();
    expect(facilities.length).toBeGreaterThanOrEqual(20);
    const ids = facilities.map((f) => f.id);
    expect(ids).toContain("meta-prineville-or");
    expect(ids).toContain("xai-colossus-memphis-tn");
  });

  it("each facility conforms to facilitySchema", () => {
    for (const f of getAllFacilities()) {
      const result = facilitySchema.safeParse(f);
      expect(result.success).toBe(true);
    }
  });
});

describe("getFacilityById", () => {
  it("returns the correct facility for a known id", () => {
    const facility = getFacilityById("meta-prineville-or");
    expect(facility).toBeDefined();
    expect(facility?.id).toBe("meta-prineville-or");
    expect(facility?.operator).toBe("Meta");
  });

  it("returns undefined for an unknown id", () => {
    expect(getFacilityById("not-a-real-facility")).toBeUndefined();
  });
});

describe("getStates", () => {
  it("returns unique state codes", () => {
    const states = getStates();
    expect(states).toEqual([...new Set(states)]);
  });

  it("returns states sorted A→Z", () => {
    const states = getStates();
    expect(states).toEqual([...states].sort());
  });

  it("each entry is exactly 2 characters", () => {
    getStates().forEach((s) => expect(s).toHaveLength(2));
  });
});

describe("getOperators", () => {
  it("returns unique operators", () => {
    const operators = getOperators();
    expect(operators).toEqual([...new Set(operators)]);
  });

  it("returns operators sorted A→Z", () => {
    const operators = getOperators();
    expect(operators).toEqual([...operators].sort());
  });
});

describe("getStatusCounts", () => {
  it("totals match the full facility count", () => {
    const counts = getStatusCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(getAllFacilities().length);
  });
});

describe("getStats", () => {
  it("returns count matching full facility list", () => {
    const { count } = getStats();
    expect(count).toBe(getAllFacilities().length);
  });

  it("returns states matching unique state count", () => {
    const { states } = getStats();
    const expectedStates = new Set(
      getAllFacilities().map((f) => f.location.state)
    ).size;
    expect(states).toBe(expectedStates);
  });

  it("operationalMw excludes cancelled facilities", () => {
    const { operationalMw } = getStats();
    const manual = getAllFacilities()
      .filter((f) => f.status !== "cancelled")
      .reduce((sum, f) => sum + (f.capacityMw?.operational ?? 0), 0);
    expect(operationalMw).toBe(manual);
  });

  it("plannedMw excludes cancelled facilities", () => {
    const { plannedMw } = getStats();
    const manual = getAllFacilities()
      .filter((f) => f.status !== "cancelled")
      .reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
    expect(plannedMw).toBe(manual);
  });

  it("operationalMw is non-negative", () => {
    const { operationalMw } = getStats();
    expect(operationalMw).toBeGreaterThanOrEqual(0);
  });

  it("plannedMw is substantially larger than operationalMw", () => {
    const { operationalMw, plannedMw } = getStats();
    // Project characteristic: planned pipeline dwarfs operational capacity
    expect(plannedMw).toBeGreaterThan(operationalMw);
  });

  it("does not expose totalMw (old API is removed)", () => {
    const stats = getStats();
    expect((stats as Record<string, unknown>).totalMw).toBeUndefined();
  });
});

describe("getCivicCoverage", () => {
  it("returns an object with all 6 dimensions", () => {
    const coverage = getCivicCoverage();
    expect(Object.keys(coverage).sort()).toEqual(
      ["community", "energy", "investment", "jobs", "subsidies", "water"]
    );
  });

  it("each dimension count is between 0 and total", () => {
    const total = getAllFacilities().length;
    const coverage = getCivicCoverage();
    for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) {
      expect(coverage[key]).toBeGreaterThanOrEqual(0);
      expect(coverage[key]).toBeLessThanOrEqual(total);
    }
  });

  it("energy count matches manual recomputation", () => {
    const facilities = getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.energy &&
        !!(f.energy.source || f.energy.utility || f.energy.onSiteGenerationMw != null || f.energy.notes)
    ).length;
    expect(getCivicCoverage().energy).toBe(expected);
  });

  it("water count matches manual recomputation", () => {
    const facilities = getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.water &&
        !!(f.water.coolingType || f.water.reportedMgd != null || f.water.notes)
    ).length;
    expect(getCivicCoverage().water).toBe(expected);
  });

  it("subsidies count matches manual recomputation", () => {
    const facilities = getAllFacilities();
    const expected = facilities.filter(
      (f) => Array.isArray(f.subsidies) && f.subsidies.length > 0
    ).length;
    expect(getCivicCoverage().subsidies).toBe(expected);
  });

  it("investment count matches manual recomputation", () => {
    const facilities = getAllFacilities();
    const expected = facilities.filter((f) => f.investmentUsd != null).length;
    expect(getCivicCoverage().investment).toBe(expected);
  });

  it("jobs count matches manual recomputation", () => {
    const facilities = getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.jobs && (f.jobs.construction != null || f.jobs.permanent != null)
    ).length;
    expect(getCivicCoverage().jobs).toBe(expected);
  });

  it("community count matches manual recomputation", () => {
    const facilities = getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.community && !!(f.community.status || f.community.notes)
    ).length;
    expect(getCivicCoverage().community).toBe(expected);
  });
});

describe("getTopStates", () => {
  it("returns at most n entries", () => {
    expect(getTopStates(10).length).toBeLessThanOrEqual(10);
  });

  it("counts are in descending (non-increasing) order", () => {
    const topStates = getTopStates(10);
    for (let i = 1; i < topStates.length; i++) {
      expect(topStates[i].count).toBeLessThanOrEqual(topStates[i - 1].count);
    }
  });

  it("each count is at least 1", () => {
    for (const { count } of getTopStates(10)) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it("sum of all states (n=all) equals total facility count", () => {
    const facilities = getAllFacilities();
    const allStates = getTopStates(facilities.length);
    const sumAll = allStates.reduce((s, { count }) => s + count, 0);
    expect(sumAll).toBe(facilities.length);
  });
});

describe("getTopOperators", () => {
  it("returns at most n entries", () => {
    expect(getTopOperators(10).length).toBeLessThanOrEqual(10);
  });

  it("counts are in descending (non-increasing) order", () => {
    const topOps = getTopOperators(10);
    for (let i = 1; i < topOps.length; i++) {
      expect(topOps[i].count).toBeLessThanOrEqual(topOps[i - 1].count);
    }
  });

  it("each count is at least 1", () => {
    for (const { count } of getTopOperators(10)) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it("sum of all operators (n=all) equals total facility count", () => {
    const facilities = getAllFacilities();
    const allOps = getTopOperators(facilities.length);
    const sumAll = allOps.reduce((s, { count }) => s + count, 0);
    expect(sumAll).toBe(facilities.length);
  });
});

describe("getAiClassificationCounts", () => {
  it("has exactly the aiClassificationEnum option keys", () => {
    const counts = getAiClassificationCounts();
    expect(Object.keys(counts).sort()).toEqual([...aiClassificationEnum.options].sort());
  });

  it("values sum to total facility count", () => {
    const counts = getAiClassificationCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(getAllFacilities().length);
  });
});

describe("getConfidenceCounts", () => {
  it("has exactly the confidenceEnum option keys", () => {
    const counts = getConfidenceCounts();
    expect(Object.keys(counts).sort()).toEqual([...confidenceEnum.options].sort());
  });

  it("values sum to total facility count", () => {
    const counts = getConfidenceCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(getAllFacilities().length);
  });
});
