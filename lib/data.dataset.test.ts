import { describe, it, expect } from "vitest";
import { countySlug } from "@/lib/counties";
import { facilitySchema } from "@/lib/schema";
import {
  getAllFacilities,
  getCounties,
  getCountyBySlug,
  getDefeatedProjects,
  getFacilitiesByCounty,
  getFacilitiesByWaterUsage,
  getGenerationByOfftaker,
  getFacilitiesByOperator,
  getOperatorSummary,
  getStats,
} from "@/lib/data";

// Real-dataset halves (DATASET=real, npm run test:dataset) of tests in
// data.test.ts whose precondition needs records the committed fixture does not
// carry: CoreSite spanning DC, two Amazon offtaker spellings, the MO independent
// city. (The default run has fixture-level versions of the county, water and
// defeated-project checks; these are the live-data counterparts.)

describe("getAllFacilities", () => {
  it("returns a real-sized dataset in which every facility conforms to facilitySchema", async () => {
    const facilities = await getAllFacilities();
    // Floor: the fixture run cannot tell a silently truncated real snapshot apart.
    expect(facilities.length).toBeGreaterThan(1000);
    const invalid = facilities.filter((f) => !facilitySchema.safeParse(f).success).map((f) => f.id);
    expect(invalid).toEqual([]);
  });
});

describe("getStats", () => {
  it("stateCodes contains known live-dataset jurisdictions (spot check)", async () => {
    const { stateCodes } = await getStats();
    // CA, TX, and DC are large/stable presences in the live dataset and are not
    // expected to disappear.
    expect(stateCodes).toEqual(expect.arrayContaining(["CA", "TX", "DC"]));
  });
});

describe("getFacilitiesByWaterUsage", () => {
  it("returns only non-cancelled facilities with a positive reportedMgd", async () => {
    const results = await getFacilitiesByWaterUsage(100);
    expect(results.length).toBeGreaterThan(0);
    for (const f of results) {
      expect(f.status).not.toBe("cancelled");
      expect(typeof f.water?.reportedMgd).toBe("number");
      expect(f.water!.reportedMgd!).toBeGreaterThan(0);
    }
  });
});

describe("getOperatorSummary", () => {
  it("stateCodes contains exactly the expected codes for CoreSite (has DC)", async () => {
    // Derived independently from live data, not from the implementation's
    // Set-building expression: looping into an object keyed by state, then
    // Object.keys().sort(), so a data wave moves both sides together.
    const facilities = await getFacilitiesByOperator("CoreSite");
    expect(facilities.length).toBeGreaterThan(0); // sanity: fixture must exist
    const stateMap: Record<string, true> = {};
    for (const f of facilities) {
      stateMap[f.location.state] = true;
    }
    const expected = Object.keys(stateMap).sort();
    // Sanity: CoreSite must have a DC facility for this test to be meaningful
    expect(expected).toContain("DC");
    expect(expected.length).toBeGreaterThanOrEqual(2);

    const summary = (await getOperatorSummary("CoreSite"))!;
    expect(summary.stateCodes).toEqual(expected);
  });
});

describe("getCounties", () => {
  it("counts sum to exactly the facilities that have a county on record", async () => {
    const counties = await getCounties();
    const facilities = await getAllFacilities();
    const withCounty = facilities.filter(
      (f) => f.location.county != null && f.location.county.trim() !== ""
    ).length;

    expect(counties.reduce((sum, c) => sum + c.count, 0)).toBe(withCounty);
    // Facilities without a county (10 today) belong to no county at all, so
    // the sum must fall short of the full dataset rather than matching it.
    expect(withCounty).toBeLessThan(facilities.length);
  });
});

describe("getCountyBySlug", () => {
  it("still resolves the MO independent city, now that it is spelled one way", async () => {
    // The live half of the old test, kept: the county the normalization pass
    // touched must still resolve, under the Census/USGS form for an
    // independent city — distinct from the surrounding "St. Louis County".
    const county = (await getCountyBySlug(countySlug("St. Louis city", "MO")))!;
    expect(county).toBeDefined();
    expect(county.state).toBe("MO");
    expect(county.name).toBe("St. Louis city");
  });
});

describe("getFacilitiesByCounty", () => {
  it("excludes every facility with no county on record", async () => {
    const facilities = await getAllFacilities();
    const countyless = new Set(
      facilities
        .filter((f) => f.location.county == null || f.location.county.trim() === "")
        .map((f) => f.id)
    );
    expect(countyless.size).toBeGreaterThan(0);

    const placed = new Set<string>();
    for (const county of await getCounties()) {
      for (const f of await getFacilitiesByCounty(county.slug)) {
        placed.add(f.id);
      }
    }
    for (const id of countyless) {
      expect(placed.has(id)).toBe(false);
    }
    expect(placed.size).toBe(facilities.length - countyless.size);
  });
});

describe("getGenerationByOfftaker", () => {
  it("merges the two Amazon spellings into one group", async () => {
    const groups = await getGenerationByOfftaker();
    const amazon = groups.find((g) => g.offtaker === "Amazon");
    expect(amazon).toBeDefined();
    expect(amazon!.facilities.length).toBeGreaterThanOrEqual(2);
  });
});

describe("getDefeatedProjects", () => {
  it("excludes a cancelled facility whose community.status is not a friction status", async () => {
    const nonFrictionCancelled = (await getAllFacilities()).find(
      (f) =>
        f.status === "cancelled" &&
        !!f.community?.status &&
        !["contested", "opposed", "litigation"].includes(f.community.status)
    );
    // Sanity-check the fixture assumption: the seed dataset carries at least
    // one cancelled facility with a non-friction community.status (e.g.
    // "supported" or "mixed") to exercise this exclusion.
    expect(nonFrictionCancelled).toBeDefined();

    const results = await getDefeatedProjects();
    expect(results.map((f) => f.id)).not.toContain(nonFrictionCancelled?.id);
  });
});
