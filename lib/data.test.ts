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
  getWaterUsage,
  getCoolingTypeCounts,
  getFacilityTypeCounts,
  getCommunityReceptionCounts,
  getEnergySourceCounts,
  getFacilitiesByState,
  getStateSummary,
  operatorSlug,
  getOperatorBySlug,
  getFacilitiesByOperator,
  getOperatorSummary,
  getPowerGenerationFacilities,
  normalizeOfftaker,
  getGenerationByOfftaker,
  getGenerationStats,
  getFacilitiesByCommunityStatus,
} from "@/lib/data";
import { facilitySchema, aiClassificationEnum, confidenceEnum } from "@/lib/schema";
import { FACILITY_TYPE_ORDER } from "@/lib/facility-type";
import { COMMUNITY_RECEPTION_ORDER } from "@/lib/community";
import { STATUS_ORDER } from "@/lib/status";
import { getFacilityMaxMw } from "@/lib/format";

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

  it("underConstructionMw is a non-negative number", () => {
    const { underConstructionMw } = getStats();
    expect(typeof underConstructionMw).toBe("number");
    expect(underConstructionMw).toBeGreaterThanOrEqual(0);
  });

  it("underConstructionMw equals manual recomputation", () => {
    const { underConstructionMw } = getStats();
    const expected = getAllFacilities()
      .filter((f) => f.status === "under_construction")
      .reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
    expect(underConstructionMw).toBe(expected);
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

  it("values sum to the count of data_center facilities that have an aiClassification set", () => {
    const counts = getAiClassificationCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    const classifiedDataCenterCount = getAllFacilities().filter(
      (f) => f.facilityType === "data_center" && f.aiClassification
    ).length;
    expect(sum).toBe(classifiedDataCenterCount);
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

describe("getWaterUsage", () => {
  it("reportingCount is between 0 and non-cancelled count", () => {
    const { reportingCount } = getWaterUsage();
    const nonCancelledCount = getAllFacilities().filter(
      (f) => f.status !== "cancelled"
    ).length;
    expect(reportingCount).toBeGreaterThanOrEqual(0);
    expect(reportingCount).toBeLessThanOrEqual(nonCancelledCount);
  });

  it("totalMgd is non-negative", () => {
    const { totalMgd } = getWaterUsage();
    expect(totalMgd).toBeGreaterThanOrEqual(0);
  });

  it("reportingCount equals manual recomputation", () => {
    const { reportingCount } = getWaterUsage();
    const expected = getAllFacilities().filter(
      (f) =>
        f.status !== "cancelled" &&
        typeof f.water?.reportedMgd === "number" &&
        f.water.reportedMgd > 0
    ).length;
    expect(reportingCount).toBe(expected);
  });

  it("totalMgd equals manual recomputation", () => {
    const { totalMgd } = getWaterUsage();
    const expected = getAllFacilities()
      .filter(
        (f) =>
          f.status !== "cancelled" &&
          typeof f.water?.reportedMgd === "number" &&
          f.water.reportedMgd > 0
      )
      .reduce((sum, f) => sum + f.water!.reportedMgd!, 0);
    expect(totalMgd).toBeCloseTo(expected, 5);
  });

  it("no cancelled facility is counted", () => {
    const facilities = getAllFacilities();
    const countedIds = facilities
      .filter(
        (f) =>
          f.status !== "cancelled" &&
          typeof f.water?.reportedMgd === "number" &&
          f.water.reportedMgd > 0
      )
      .map((f) => f.id);
    const cancelledIds = new Set(
      facilities.filter((f) => f.status === "cancelled").map((f) => f.id)
    );
    for (const id of countedIds) {
      expect(cancelledIds.has(id)).toBe(false);
    }
  });
});

describe("getFacilityTypeCounts", () => {
  it("has exactly the FACILITY_TYPE_ORDER keys", () => {
    const counts = getFacilityTypeCounts();
    expect(Object.keys(counts).sort()).toEqual([...FACILITY_TYPE_ORDER].sort());
  });

  it("each value is non-negative", () => {
    const counts = getFacilityTypeCounts();
    for (const key of FACILITY_TYPE_ORDER) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("values sum to the total facility count", () => {
    const counts = getFacilityTypeCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(getAllFacilities().length);
  });

  it("equals manual recomputation per key", () => {
    const counts = getFacilityTypeCounts();
    const facilities = getAllFacilities();
    for (const key of FACILITY_TYPE_ORDER) {
      const expected = facilities.filter((f) => f.facilityType === key).length;
      expect(counts[key]).toBe(expected);
    }
  });
});

describe("getCommunityReceptionCounts", () => {
  it("has exactly the COMMUNITY_RECEPTION_ORDER keys", () => {
    const counts = getCommunityReceptionCounts();
    expect(Object.keys(counts).sort()).toEqual([...COMMUNITY_RECEPTION_ORDER].sort());
  });

  it("each value is non-negative", () => {
    const counts = getCommunityReceptionCounts();
    for (const key of COMMUNITY_RECEPTION_ORDER) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("sum is at most the total facility count", () => {
    const counts = getCommunityReceptionCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(getAllFacilities().length);
  });

  it("equals manual recomputation per key", () => {
    const counts = getCommunityReceptionCounts();
    const facilities = getAllFacilities();
    for (const key of COMMUNITY_RECEPTION_ORDER) {
      const expected = facilities.filter((f) => f.community?.status === key).length;
      expect(counts[key]).toBe(expected);
    }
  });

  it("facilities without a community.status are not counted in any bucket", () => {
    const counts = getCommunityReceptionCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    const withStatus = getAllFacilities().filter((f) => !!f.community?.status).length;
    expect(sum).toBe(withStatus);
  });
});

describe("getCoolingTypeCounts", () => {
  const COOLING_KEYS = ["evaporative", "air", "closed_loop", "hybrid", "unknown"] as const;

  it("has exactly the 5 cooling type keys", () => {
    const counts = getCoolingTypeCounts();
    expect(Object.keys(counts).sort()).toEqual([...COOLING_KEYS].sort());
  });

  it("each value is non-negative", () => {
    const counts = getCoolingTypeCounts();
    for (const key of COOLING_KEYS) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("sum is at most the non-cancelled facility count", () => {
    const counts = getCoolingTypeCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    const nonCancelledCount = getAllFacilities().filter(
      (f) => f.status !== "cancelled"
    ).length;
    expect(sum).toBeLessThanOrEqual(nonCancelledCount);
  });

  it("equals manual recomputation per key", () => {
    const counts = getCoolingTypeCounts();
    const facilities = getAllFacilities().filter(
      (f) => f.status !== "cancelled" && f.water?.coolingType
    );
    for (const key of COOLING_KEYS) {
      const expected = facilities.filter(
        (f) => f.water?.coolingType === key
      ).length;
      expect(counts[key]).toBe(expected);
    }
  });
});

describe("getEnergySourceCounts", () => {
  const ENERGY_SOURCE_KEYS = [
    "grid",
    "on_site_gas",
    "nuclear",
    "solar",
    "wind",
    "hydro",
    "mixed",
    "other",
  ] as const;

  it("has exactly the 8 energy source keys", () => {
    const counts = getEnergySourceCounts();
    expect(Object.keys(counts).sort()).toEqual([...ENERGY_SOURCE_KEYS].sort());
  });

  it("each value is non-negative", () => {
    const counts = getEnergySourceCounts();
    for (const key of ENERGY_SOURCE_KEYS) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("sum is at most the total facility count", () => {
    const counts = getEnergySourceCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(getAllFacilities().length);
  });

  it("equals manual recomputation per key", () => {
    const counts = getEnergySourceCounts();
    const facilities = getAllFacilities().filter((f) => f.energy?.source);
    for (const key of ENERGY_SOURCE_KEYS) {
      const expected = facilities.filter(
        (f) => f.energy?.source === key
      ).length;
      expect(counts[key]).toBe(expected);
    }
  });
});

describe("getFacilitiesByState", () => {
  it("is case-insensitive and non-empty for a known state", () => {
    const lower = getFacilitiesByState("ny");
    const upper = getFacilitiesByState("NY");
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBeGreaterThan(0);
  });

  it("partitions the full dataset (every facility has exactly one state)", () => {
    const sum = getStates().reduce(
      (s, code) => s + getFacilitiesByState(code).length,
      0
    );
    expect(sum).toBe(getAllFacilities().length);
  });

  it("sorts results by capacity desc", () => {
    const txFacilities = getFacilitiesByState("TX");
    expect(txFacilities.length).toBeGreaterThan(1);
    const maxMws = txFacilities.map((f) => getFacilityMaxMw(f) ?? -1);
    expect(maxMws[0]).toBeGreaterThanOrEqual(maxMws[maxMws.length - 1]);
  });
});

describe("getStateSummary", () => {
  it("returns null for a state with zero facilities", () => {
    expect(getStateSummary("ZZ")).toBeNull();
  });

  it("count matches getFacilitiesByState length", () => {
    const summary = getStateSummary("NY");
    expect(summary).not.toBeNull();
    expect(summary!.count).toBe(getFacilitiesByState("NY").length);
  });

  it("includes all byType and byStatus keys", () => {
    const summary = getStateSummary("NY")!;
    expect(Object.keys(summary.byType).sort()).toEqual(
      [...FACILITY_TYPE_ORDER].sort()
    );
    expect(Object.keys(summary.byStatus).sort()).toEqual(
      [...STATUS_ORDER].sort()
    );
  });

  it("maintains communityFriction <= communityReporting <= count", () => {
    for (const code of getStates()) {
      const summary = getStateSummary(code)!;
      expect(summary.communityFriction).toBeLessThanOrEqual(
        summary.communityReporting
      );
      expect(summary.communityReporting).toBeLessThanOrEqual(summary.count);
    }
  });

  it("sorts topOperators by count desc", () => {
    const summary = getStateSummary("TX")!;
    for (let i = 1; i < summary.topOperators.length; i++) {
      expect(summary.topOperators[i - 1].count).toBeGreaterThanOrEqual(
        summary.topOperators[i].count
      );
    }
  });
});

describe("operatorSlug", () => {
  it("slugifies a multi-word operator name", () => {
    expect(operatorSlug("Amazon Web Services")).toBe("amazon-web-services");
  });

  it("round-trips through getOperatorBySlug for every tracked operator", () => {
    for (const name of getOperators()) {
      expect(getOperatorBySlug(operatorSlug(name))).toBe(name);
    }
  });
});

describe("getOperatorBySlug", () => {
  it("returns undefined for an unknown slug", () => {
    expect(getOperatorBySlug("not-a-real-operator")).toBeUndefined();
  });
});

describe("getFacilitiesByOperator", () => {
  it("returns exactly the operator's facilities for a known multi-facility operator", () => {
    const expected = getAllFacilities().filter((f) => f.operator === "Google");
    const results = getFacilitiesByOperator("Google");
    expect(results.length).toBe(expected.length);
    for (const f of results) {
      expect(f.operator).toBe("Google");
    }
  });

  it("sorts results by capacity desc", () => {
    const results = getFacilitiesByOperator("Google");
    expect(results.length).toBeGreaterThan(1);
    const maxMws = results.map((f) => getFacilityMaxMw(f) ?? -1);
    for (let i = 1; i < maxMws.length; i++) {
      expect(maxMws[i - 1]).toBeGreaterThanOrEqual(maxMws[i]);
    }
  });

  it("partitions the full dataset (every facility has exactly one operator)", () => {
    const sum = getOperators().reduce(
      (s, name) => s + getFacilitiesByOperator(name).length,
      0
    );
    expect(sum).toBe(getAllFacilities().length);
  });
});

describe("getOperatorSummary", () => {
  it("returns null for an unknown operator", () => {
    expect(getOperatorSummary("__nope__")).toBeNull();
  });

  it("count matches getFacilitiesByOperator length", () => {
    for (const name of getOperators()) {
      const summary = getOperatorSummary(name);
      expect(summary).not.toBeNull();
      expect(summary!.count).toBe(getFacilitiesByOperator(name).length);
    }
  });

  it("includes all byType and byStatus keys", () => {
    const summary = getOperatorSummary("Google")!;
    expect(Object.keys(summary.byType).sort()).toEqual(
      [...FACILITY_TYPE_ORDER].sort()
    );
    expect(Object.keys(summary.byStatus).sort()).toEqual(
      [...STATUS_ORDER].sort()
    );
  });

  it("stateCount matches the distinct state count for the operator's facilities", () => {
    const summary = getOperatorSummary("Google")!;
    const expected = new Set(
      getFacilitiesByOperator("Google").map((f) => f.location.state)
    ).size;
    expect(summary.stateCount).toBe(expected);
  });
});

describe("getPowerGenerationFacilities", () => {
  it("returns exactly the power_generation subset of getAllFacilities", () => {
    const expected = getAllFacilities().filter(
      (f) => f.facilityType === "power_generation"
    );
    expect(getPowerGenerationFacilities().length).toBe(expected.length);
  });

  it("every result has facilityType power_generation", () => {
    for (const f of getPowerGenerationFacilities()) {
      expect(f.facilityType).toBe("power_generation");
    }
  });
});

describe("normalizeOfftaker", () => {
  it("strips a trailing parenthetical", () => {
    expect(normalizeOfftaker("Amazon (AWS)")).toBe("Amazon");
  });

  it("leaves a plain name unchanged", () => {
    expect(normalizeOfftaker("Meta")).toBe("Meta");
    expect(normalizeOfftaker("Amazon")).toBe("Amazon");
  });
});

describe("getGenerationByOfftaker", () => {
  it("merges the two Amazon spellings into one group", () => {
    const groups = getGenerationByOfftaker();
    const amazon = groups.find((g) => g.offtaker === "Amazon");
    expect(amazon).toBeDefined();
    expect(amazon!.facilities.length).toBeGreaterThanOrEqual(2);
  });

  it("has no group label containing a parenthetical", () => {
    const groups = getGenerationByOfftaker();
    for (const g of groups) {
      expect(g.offtaker).not.toContain("(");
    }
  });

  it("sorts groups by totalMw desc", () => {
    const groups = getGenerationByOfftaker();
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i - 1].totalMw).toBeGreaterThanOrEqual(groups[i].totalMw);
    }
  });
});

describe("getGenerationStats", () => {
  it("count matches getPowerGenerationFacilities length", () => {
    expect(getGenerationStats().count).toBe(
      getPowerGenerationFacilities().length
    );
  });

  it("offtakerCount matches the distinct normalized offtaker count", () => {
    const distinct = new Set(
      getPowerGenerationFacilities()
        .map((f) => f.generation?.offtaker)
        .filter((o): o is string => !!o)
        .map(normalizeOfftaker)
    );
    expect(getGenerationStats().offtakerCount).toBe(distinct.size);
  });
});

describe("getFacilitiesByCommunityStatus", () => {
  it("returns exactly the litigation subset, each with that status", () => {
    const expected = getAllFacilities().filter(
      (f) => f.community?.status === "litigation"
    );
    const results = getFacilitiesByCommunityStatus("litigation");
    expect(results.length).toBe(expected.length);
    for (const f of results) {
      expect(f.community?.status).toBe("litigation");
    }
  });

  it("sorts results by capacity desc", () => {
    const contested = getFacilitiesByCommunityStatus("contested");
    expect(contested.length).toBeGreaterThan(1);
    const maxMws = contested.map((f) => getFacilityMaxMw(f) ?? -1);
    for (let i = 1; i < maxMws.length; i++) {
      expect(maxMws[i - 1]).toBeGreaterThanOrEqual(maxMws[i]);
    }
  });

  it("the three friction statuses partition the friction subset of the dataset", () => {
    const frictionStatuses = ["contested", "opposed", "litigation"] as const;
    const sum = frictionStatuses.reduce(
      (n, status) => n + getFacilitiesByCommunityStatus(status).length,
      0
    );
    const expected = getAllFacilities().filter((f) =>
      (frictionStatuses as readonly string[]).includes(f.community?.status ?? "")
    ).length;
    expect(sum).toBe(expected);
  });
});
