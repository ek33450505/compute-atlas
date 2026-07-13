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
  getPoweredCampuses,
  getPoweredByGenerators,
} from "@/lib/data";
import { facilitySchema, aiClassificationEnum, confidenceEnum } from "@/lib/schema";
import { FACILITY_TYPE_ORDER } from "@/lib/facility-type";
import { COMMUNITY_RECEPTION_ORDER } from "@/lib/community";
import { STATUS_ORDER } from "@/lib/status";
import { getFacilityMaxMw } from "@/lib/format";

describe("getAllFacilities", () => {
  it("returns a non-empty array including known seed ids", async () => {
    const facilities = await getAllFacilities();
    expect(facilities.length).toBeGreaterThanOrEqual(20);
    const ids = facilities.map((f) => f.id);
    expect(ids).toContain("meta-prineville-or");
    expect(ids).toContain("xai-colossus-memphis-tn");
  });

  it("each facility conforms to facilitySchema", async () => {
    for (const f of await getAllFacilities()) {
      const result = facilitySchema.safeParse(f);
      expect(result.success).toBe(true);
    }
  });
});

describe("getFacilityById", () => {
  it("returns the correct facility for a known id", async () => {
    const facility = await getFacilityById("meta-prineville-or");
    expect(facility).toBeDefined();
    expect(facility?.id).toBe("meta-prineville-or");
    expect(facility?.operator).toBe("Meta");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await getFacilityById("not-a-real-facility")).toBeUndefined();
  });
});

describe("getStates", () => {
  it("returns unique state codes", async () => {
    const states = await getStates();
    expect(states).toEqual([...new Set(states)]);
  });

  it("returns states sorted A→Z", async () => {
    const states = await getStates();
    expect(states).toEqual([...states].sort());
  });

  it("each entry is exactly 2 characters", async () => {
    (await getStates()).forEach((s) => expect(s).toHaveLength(2));
  });
});

describe("getOperators", () => {
  it("returns unique operators", async () => {
    const operators = await getOperators();
    expect(operators).toEqual([...new Set(operators)]);
  });

  it("returns operators sorted A→Z", async () => {
    const operators = await getOperators();
    expect(operators).toEqual([...operators].sort());
  });
});

describe("getStatusCounts", () => {
  it("totals match the full facility count", async () => {
    const counts = await getStatusCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe((await getAllFacilities()).length);
  });
});

describe("getStats", () => {
  it("returns count matching full facility list", async () => {
    const { count } = await getStats();
    expect(count).toBe((await getAllFacilities()).length);
  });

  it("returns states matching unique state count", async () => {
    const { states } = await getStats();
    const expectedStates = new Set(
      (await getAllFacilities()).map((f) => f.location.state)
    ).size;
    expect(states).toBe(expectedStates);
  });

  it("operationalMw excludes cancelled facilities", async () => {
    const { operationalMw } = await getStats();
    const manual = (await getAllFacilities())
      .filter((f) => f.status !== "cancelled")
      .reduce((sum, f) => sum + (f.capacityMw?.operational ?? 0), 0);
    expect(operationalMw).toBe(manual);
  });

  it("plannedMw excludes cancelled facilities", async () => {
    const { plannedMw } = await getStats();
    const manual = (await getAllFacilities())
      .filter((f) => f.status !== "cancelled")
      .reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
    expect(plannedMw).toBe(manual);
  });

  it("operationalMw is non-negative", async () => {
    const { operationalMw } = await getStats();
    expect(operationalMw).toBeGreaterThanOrEqual(0);
  });

  it("plannedMw is substantially larger than operationalMw", async () => {
    const { operationalMw, plannedMw } = await getStats();
    // Project characteristic: planned pipeline dwarfs operational capacity
    expect(plannedMw).toBeGreaterThan(operationalMw);
  });

  it("does not expose totalMw (old API is removed)", async () => {
    const stats = await getStats();
    expect((stats as Record<string, unknown>).totalMw).toBeUndefined();
  });

  it("underConstructionMw is a non-negative number", async () => {
    const { underConstructionMw } = await getStats();
    expect(typeof underConstructionMw).toBe("number");
    expect(underConstructionMw).toBeGreaterThanOrEqual(0);
  });

  it("underConstructionMw equals manual recomputation", async () => {
    const { underConstructionMw } = await getStats();
    const expected = (await getAllFacilities())
      .filter((f) => f.status === "under_construction")
      .reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
    expect(underConstructionMw).toBe(expected);
  });
});

describe("getCivicCoverage", () => {
  it("returns an object with all 6 dimensions", async () => {
    const coverage = await getCivicCoverage();
    expect(Object.keys(coverage).sort()).toEqual(
      ["community", "energy", "investment", "jobs", "subsidies", "water"]
    );
  });

  it("each dimension count is between 0 and total", async () => {
    const total = (await getAllFacilities()).length;
    const coverage = await getCivicCoverage();
    for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) {
      expect(coverage[key]).toBeGreaterThanOrEqual(0);
      expect(coverage[key]).toBeLessThanOrEqual(total);
    }
  });

  it("energy count matches manual recomputation", async () => {
    const facilities = await getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.energy &&
        !!(f.energy.source || f.energy.utility || f.energy.onSiteGenerationMw != null || f.energy.notes)
    ).length;
    expect((await getCivicCoverage()).energy).toBe(expected);
  });

  it("water count matches manual recomputation", async () => {
    const facilities = await getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.water &&
        !!(f.water.coolingType || f.water.reportedMgd != null || f.water.notes)
    ).length;
    expect((await getCivicCoverage()).water).toBe(expected);
  });

  it("subsidies count matches manual recomputation", async () => {
    const facilities = await getAllFacilities();
    const expected = facilities.filter(
      (f) => Array.isArray(f.subsidies) && f.subsidies.length > 0
    ).length;
    expect((await getCivicCoverage()).subsidies).toBe(expected);
  });

  it("investment count matches manual recomputation", async () => {
    const facilities = await getAllFacilities();
    const expected = facilities.filter((f) => f.investmentUsd != null).length;
    expect((await getCivicCoverage()).investment).toBe(expected);
  });

  it("jobs count matches manual recomputation", async () => {
    const facilities = await getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.jobs && (f.jobs.construction != null || f.jobs.permanent != null)
    ).length;
    expect((await getCivicCoverage()).jobs).toBe(expected);
  });

  it("community count matches manual recomputation", async () => {
    const facilities = await getAllFacilities();
    const expected = facilities.filter(
      (f) =>
        !!f.community && !!(f.community.status || f.community.notes)
    ).length;
    expect((await getCivicCoverage()).community).toBe(expected);
  });
});

describe("getTopStates", () => {
  it("returns at most n entries", async () => {
    expect((await getTopStates(10)).length).toBeLessThanOrEqual(10);
  });

  it("counts are in descending (non-increasing) order", async () => {
    const topStates = await getTopStates(10);
    for (let i = 1; i < topStates.length; i++) {
      expect(topStates[i].count).toBeLessThanOrEqual(topStates[i - 1].count);
    }
  });

  it("each count is at least 1", async () => {
    for (const { count } of await getTopStates(10)) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it("sum of all states (n=all) equals total facility count", async () => {
    const facilities = await getAllFacilities();
    const allStates = await getTopStates(facilities.length);
    const sumAll = allStates.reduce((s, { count }) => s + count, 0);
    expect(sumAll).toBe(facilities.length);
  });
});

describe("getTopOperators", () => {
  it("returns at most n entries", async () => {
    expect((await getTopOperators(10)).length).toBeLessThanOrEqual(10);
  });

  it("counts are in descending (non-increasing) order", async () => {
    const topOps = await getTopOperators(10);
    for (let i = 1; i < topOps.length; i++) {
      expect(topOps[i].count).toBeLessThanOrEqual(topOps[i - 1].count);
    }
  });

  it("each count is at least 1", async () => {
    for (const { count } of await getTopOperators(10)) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it("sum of all operators (n=all) equals total facility count", async () => {
    const facilities = await getAllFacilities();
    const allOps = await getTopOperators(facilities.length);
    const sumAll = allOps.reduce((s, { count }) => s + count, 0);
    expect(sumAll).toBe(facilities.length);
  });
});

describe("getAiClassificationCounts", () => {
  it("has exactly the aiClassificationEnum option keys", async () => {
    const counts = await getAiClassificationCounts();
    expect(Object.keys(counts).sort()).toEqual([...aiClassificationEnum.options].sort());
  });

  it("values sum to the count of data_center facilities that have an aiClassification set", async () => {
    const counts = await getAiClassificationCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    const classifiedDataCenterCount = (await getAllFacilities()).filter(
      (f) => f.facilityType === "data_center" && f.aiClassification
    ).length;
    expect(sum).toBe(classifiedDataCenterCount);
  });
});

describe("getConfidenceCounts", () => {
  it("has exactly the confidenceEnum option keys", async () => {
    const counts = await getConfidenceCounts();
    expect(Object.keys(counts).sort()).toEqual([...confidenceEnum.options].sort());
  });

  it("values sum to total facility count", async () => {
    const counts = await getConfidenceCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe((await getAllFacilities()).length);
  });
});

describe("getWaterUsage", () => {
  it("reportingCount is between 0 and non-cancelled count", async () => {
    const { reportingCount } = await getWaterUsage();
    const nonCancelledCount = (await getAllFacilities()).filter(
      (f) => f.status !== "cancelled"
    ).length;
    expect(reportingCount).toBeGreaterThanOrEqual(0);
    expect(reportingCount).toBeLessThanOrEqual(nonCancelledCount);
  });

  it("totalMgd is non-negative", async () => {
    const { totalMgd } = await getWaterUsage();
    expect(totalMgd).toBeGreaterThanOrEqual(0);
  });

  it("reportingCount equals manual recomputation", async () => {
    const { reportingCount } = await getWaterUsage();
    const expected = (await getAllFacilities()).filter(
      (f) =>
        f.status !== "cancelled" &&
        typeof f.water?.reportedMgd === "number" &&
        f.water.reportedMgd > 0
    ).length;
    expect(reportingCount).toBe(expected);
  });

  it("totalMgd equals manual recomputation", async () => {
    const { totalMgd } = await getWaterUsage();
    const expected = (await getAllFacilities())
      .filter(
        (f) =>
          f.status !== "cancelled" &&
          typeof f.water?.reportedMgd === "number" &&
          f.water.reportedMgd > 0
      )
      .reduce((sum, f) => sum + f.water!.reportedMgd!, 0);
    expect(totalMgd).toBeCloseTo(expected, 5);
  });

  it("no cancelled facility is counted", async () => {
    const facilities = await getAllFacilities();
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
  it("has exactly the FACILITY_TYPE_ORDER keys", async () => {
    const counts = await getFacilityTypeCounts();
    expect(Object.keys(counts).sort()).toEqual([...FACILITY_TYPE_ORDER].sort());
  });

  it("each value is non-negative", async () => {
    const counts = await getFacilityTypeCounts();
    for (const key of FACILITY_TYPE_ORDER) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("values sum to the total facility count", async () => {
    const counts = await getFacilityTypeCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe((await getAllFacilities()).length);
  });

  it("equals manual recomputation per key", async () => {
    const counts = await getFacilityTypeCounts();
    const facilities = await getAllFacilities();
    for (const key of FACILITY_TYPE_ORDER) {
      const expected = facilities.filter((f) => f.facilityType === key).length;
      expect(counts[key]).toBe(expected);
    }
  });
});

describe("getCommunityReceptionCounts", () => {
  it("has exactly the COMMUNITY_RECEPTION_ORDER keys", async () => {
    const counts = await getCommunityReceptionCounts();
    expect(Object.keys(counts).sort()).toEqual([...COMMUNITY_RECEPTION_ORDER].sort());
  });

  it("each value is non-negative", async () => {
    const counts = await getCommunityReceptionCounts();
    for (const key of COMMUNITY_RECEPTION_ORDER) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("sum is at most the total facility count", async () => {
    const counts = await getCommunityReceptionCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual((await getAllFacilities()).length);
  });

  it("equals manual recomputation per key", async () => {
    const counts = await getCommunityReceptionCounts();
    const facilities = await getAllFacilities();
    for (const key of COMMUNITY_RECEPTION_ORDER) {
      const expected = facilities.filter((f) => f.community?.status === key).length;
      expect(counts[key]).toBe(expected);
    }
  });

  it("facilities without a community.status are not counted in any bucket", async () => {
    const counts = await getCommunityReceptionCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    const withStatus = (await getAllFacilities()).filter((f) => !!f.community?.status).length;
    expect(sum).toBe(withStatus);
  });
});

describe("getCoolingTypeCounts", () => {
  const COOLING_KEYS = ["evaporative", "air", "closed_loop", "hybrid", "unknown"] as const;

  it("has exactly the 5 cooling type keys", async () => {
    const counts = await getCoolingTypeCounts();
    expect(Object.keys(counts).sort()).toEqual([...COOLING_KEYS].sort());
  });

  it("each value is non-negative", async () => {
    const counts = await getCoolingTypeCounts();
    for (const key of COOLING_KEYS) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("sum is at most the non-cancelled facility count", async () => {
    const counts = await getCoolingTypeCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    const nonCancelledCount = (await getAllFacilities()).filter(
      (f) => f.status !== "cancelled"
    ).length;
    expect(sum).toBeLessThanOrEqual(nonCancelledCount);
  });

  it("equals manual recomputation per key", async () => {
    const counts = await getCoolingTypeCounts();
    const facilities = (await getAllFacilities()).filter(
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

  it("has exactly the 8 energy source keys", async () => {
    const counts = await getEnergySourceCounts();
    expect(Object.keys(counts).sort()).toEqual([...ENERGY_SOURCE_KEYS].sort());
  });

  it("each value is non-negative", async () => {
    const counts = await getEnergySourceCounts();
    for (const key of ENERGY_SOURCE_KEYS) {
      expect(counts[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("sum is at most the total facility count", async () => {
    const counts = await getEnergySourceCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual((await getAllFacilities()).length);
  });

  it("equals manual recomputation per key", async () => {
    const counts = await getEnergySourceCounts();
    const facilities = (await getAllFacilities()).filter((f) => f.energy?.source);
    for (const key of ENERGY_SOURCE_KEYS) {
      const expected = facilities.filter(
        (f) => f.energy?.source === key
      ).length;
      expect(counts[key]).toBe(expected);
    }
  });
});

describe("getFacilitiesByState", () => {
  it("is case-insensitive and non-empty for a known state", async () => {
    const lower = await getFacilitiesByState("ny");
    const upper = await getFacilitiesByState("NY");
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBeGreaterThan(0);
  });

  it("partitions the full dataset (every facility has exactly one state)", async () => {
    const states = await getStates();
    let sum = 0;
    for (const code of states) {
      sum += (await getFacilitiesByState(code)).length;
    }
    expect(sum).toBe((await getAllFacilities()).length);
  });

  it("sorts results by capacity desc", async () => {
    const txFacilities = await getFacilitiesByState("TX");
    expect(txFacilities.length).toBeGreaterThan(1);
    const maxMws = txFacilities.map((f) => getFacilityMaxMw(f) ?? -1);
    expect(maxMws[0]).toBeGreaterThanOrEqual(maxMws[maxMws.length - 1]);
  });
});

describe("getStateSummary", () => {
  it("returns null for a state with zero facilities", async () => {
    expect(await getStateSummary("ZZ")).toBeNull();
  });

  it("count matches getFacilitiesByState length", async () => {
    const summary = await getStateSummary("NY");
    expect(summary).not.toBeNull();
    expect(summary!.count).toBe((await getFacilitiesByState("NY")).length);
  });

  it("includes all byType and byStatus keys", async () => {
    const summary = (await getStateSummary("NY"))!;
    expect(Object.keys(summary.byType).sort()).toEqual(
      [...FACILITY_TYPE_ORDER].sort()
    );
    expect(Object.keys(summary.byStatus).sort()).toEqual(
      [...STATUS_ORDER].sort()
    );
  });

  it("maintains communityFriction <= communityReporting <= count", async () => {
    for (const code of await getStates()) {
      const summary = (await getStateSummary(code))!;
      expect(summary.communityFriction).toBeLessThanOrEqual(
        summary.communityReporting
      );
      expect(summary.communityReporting).toBeLessThanOrEqual(summary.count);
    }
  });

  it("sorts topOperators by count desc", async () => {
    const summary = (await getStateSummary("TX"))!;
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

  it("round-trips through getOperatorBySlug for every tracked operator", async () => {
    for (const name of await getOperators()) {
      expect(await getOperatorBySlug(operatorSlug(name))).toBe(name);
    }
  });
});

describe("getOperatorBySlug", () => {
  it("returns undefined for an unknown slug", async () => {
    expect(await getOperatorBySlug("not-a-real-operator")).toBeUndefined();
  });
});

describe("getFacilitiesByOperator", () => {
  it("returns exactly the operator's facilities for a known multi-facility operator", async () => {
    const expected = (await getAllFacilities()).filter((f) => f.operator === "Google");
    const results = await getFacilitiesByOperator("Google");
    expect(results.length).toBe(expected.length);
    for (const f of results) {
      expect(f.operator).toBe("Google");
    }
  });

  it("sorts results by capacity desc", async () => {
    const results = await getFacilitiesByOperator("Google");
    expect(results.length).toBeGreaterThan(1);
    const maxMws = results.map((f) => getFacilityMaxMw(f) ?? -1);
    for (let i = 1; i < maxMws.length; i++) {
      expect(maxMws[i - 1]).toBeGreaterThanOrEqual(maxMws[i]);
    }
  });

  it("partitions the full dataset (every facility has exactly one operator)", async () => {
    const operators = await getOperators();
    let sum = 0;
    for (const name of operators) {
      sum += (await getFacilitiesByOperator(name)).length;
    }
    expect(sum).toBe((await getAllFacilities()).length);
  });
});

describe("getOperatorSummary", () => {
  it("returns null for an unknown operator", async () => {
    expect(await getOperatorSummary("__nope__")).toBeNull();
  });

  it("count matches getFacilitiesByOperator length", async () => {
    for (const name of await getOperators()) {
      const summary = await getOperatorSummary(name);
      expect(summary).not.toBeNull();
      expect(summary!.count).toBe((await getFacilitiesByOperator(name)).length);
    }
  });

  it("includes all byType and byStatus keys", async () => {
    const summary = (await getOperatorSummary("Google"))!;
    expect(Object.keys(summary.byType).sort()).toEqual(
      [...FACILITY_TYPE_ORDER].sort()
    );
    expect(Object.keys(summary.byStatus).sort()).toEqual(
      [...STATUS_ORDER].sort()
    );
  });

  it("stateCount matches the distinct state count for the operator's facilities", async () => {
    const summary = (await getOperatorSummary("Google"))!;
    const expected = new Set(
      (await getFacilitiesByOperator("Google")).map((f) => f.location.state)
    ).size;
    expect(summary.stateCount).toBe(expected);
  });
});

describe("getPowerGenerationFacilities", () => {
  it("returns exactly the power_generation subset of getAllFacilities", async () => {
    const expected = (await getAllFacilities()).filter(
      (f) => f.facilityType === "power_generation"
    );
    expect((await getPowerGenerationFacilities()).length).toBe(expected.length);
  });

  it("every result has facilityType power_generation", async () => {
    for (const f of await getPowerGenerationFacilities()) {
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
  it("merges the two Amazon spellings into one group", async () => {
    const groups = await getGenerationByOfftaker();
    const amazon = groups.find((g) => g.offtaker === "Amazon");
    expect(amazon).toBeDefined();
    expect(amazon!.facilities.length).toBeGreaterThanOrEqual(2);
  });

  it("has no group label containing a parenthetical", async () => {
    const groups = await getGenerationByOfftaker();
    for (const g of groups) {
      expect(g.offtaker).not.toContain("(");
    }
  });

  it("sorts groups by totalMw desc", async () => {
    const groups = await getGenerationByOfftaker();
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i - 1].totalMw).toBeGreaterThanOrEqual(groups[i].totalMw);
    }
  });
});

describe("getGenerationStats", () => {
  it("count matches getPowerGenerationFacilities length", async () => {
    expect((await getGenerationStats()).count).toBe(
      (await getPowerGenerationFacilities()).length
    );
  });

  it("offtakerCount matches the distinct normalized offtaker count", async () => {
    const distinct = new Set(
      (await getPowerGenerationFacilities())
        .map((f) => f.generation?.offtaker)
        .filter((o): o is string => !!o)
        .map(normalizeOfftaker)
    );
    expect((await getGenerationStats()).offtakerCount).toBe(distinct.size);
  });
});

describe("getFacilitiesByCommunityStatus", () => {
  it("returns exactly the litigation subset, each with that status", async () => {
    const expected = (await getAllFacilities()).filter(
      (f) => f.community?.status === "litigation"
    );
    const results = await getFacilitiesByCommunityStatus("litigation");
    expect(results.length).toBe(expected.length);
    for (const f of results) {
      expect(f.community?.status).toBe("litigation");
    }
  });

  it("sorts results by capacity desc", async () => {
    const contested = await getFacilitiesByCommunityStatus("contested");
    expect(contested.length).toBeGreaterThan(1);
    const maxMws = contested.map((f) => getFacilityMaxMw(f) ?? -1);
    for (let i = 1; i < maxMws.length; i++) {
      expect(maxMws[i - 1]).toBeGreaterThanOrEqual(maxMws[i]);
    }
  });

  it("the three friction statuses partition the friction subset of the dataset", async () => {
    const frictionStatuses = ["contested", "opposed", "litigation"] as const;
    let sum = 0;
    for (const status of frictionStatuses) {
      sum += (await getFacilitiesByCommunityStatus(status)).length;
    }
    const expected = (await getAllFacilities()).filter((f) =>
      (frictionStatuses as readonly string[]).includes(f.community?.status ?? "")
    ).length;
    expect(sum).toBe(expected);
  });
});

describe("getPoweredCampuses", () => {
  it("resolves the Oklo Aurora -> Meta Prometheus link", async () => {
    const oklo = await getFacilityById("oklo-aurora-pike-county-oh");
    expect(oklo).toBeDefined();
    const campuses = await getPoweredCampuses(oklo!);
    expect(campuses.map((f) => f.id)).toEqual(["meta-prometheus-new-albany-oh"]);
  });

  it("resolves the Susquehanna -> AWS Cumulus link", async () => {
    const susquehanna = await getFacilityById("talen-susquehanna-aws-pa");
    expect(susquehanna).toBeDefined();
    const campuses = await getPoweredCampuses(susquehanna!);
    expect(campuses.map((f) => f.id)).toEqual(["aws-cumulus-salem-township-pa"]);
  });

  it("returns [] for a power_generation facility with no poweredFacilityIds", async () => {
    const crane = await getFacilityById("crane-clean-energy-center-tmi-pa");
    expect(crane).toBeDefined();
    expect(await getPoweredCampuses(crane!)).toEqual([]);
  });

  it("returns [] for a non-power_generation facility (wrong branch)", async () => {
    const meta = await getFacilityById("meta-prometheus-new-albany-oh");
    expect(meta).toBeDefined();
    expect(await getPoweredCampuses(meta!)).toEqual([]);
  });
});

describe("getPoweredByGenerators", () => {
  it("resolves Meta Prometheus <- Oklo Aurora", async () => {
    const meta = await getFacilityById("meta-prometheus-new-albany-oh");
    expect(meta).toBeDefined();
    const generators = await getPoweredByGenerators(meta!);
    expect(generators.map((f) => f.id)).toEqual(["oklo-aurora-pike-county-oh"]);
  });

  it("resolves AWS Cumulus <- Susquehanna", async () => {
    const aws = await getFacilityById("aws-cumulus-salem-township-pa");
    expect(aws).toBeDefined();
    const generators = await getPoweredByGenerators(aws!);
    expect(generators.map((f) => f.id)).toEqual(["talen-susquehanna-aws-pa"]);
  });

  it("returns [] for a facility no plant powers", async () => {
    const facility = await getFacilityById("meta-prineville-or");
    expect(facility).toBeDefined();
    expect(await getPoweredByGenerators(facility!)).toEqual([]);
  });
});
