import { describe, it, expect } from "vitest";
import {
  getAllFacilities,
  getWaterStressExposure,
  computeWaterStressExposure,
  type WaterStressExposure,
} from "@/lib/data";
import { getSitingContext, type SitingContext } from "@/lib/siting-context";
import type { DataCenterFacility, Facility } from "@/lib/schema";

/**
 * Minimal valid DataCenterFacility fixture — mirrors the makeFacility()
 * pattern in lib/filters.test.ts / lib/data.test.ts's makeGenerationFacility:
 * every required baseFacilityShape field supplied directly, no `as` cast.
 */
function makeFacility(
  overrides: Partial<DataCenterFacility> & { id: string; status: Facility["status"] }
): DataCenterFacility {
  return {
    name: "Test Facility",
    operator: "Test Operator",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 35, lon: -90, state: "TX", precision: "exact" },
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
    facilityType: "data_center",
    ...overrides,
  };
}

/** Builds the `lookupSitingContext` fixture `computeWaterStressExposure` takes. */
function makeLookup(
  entries: Record<string, SitingContext>
): (id: string) => SitingContext | undefined {
  const byId = new Map(Object.entries(entries));
  return (id: string) => byId.get(id);
}

describe("computeWaterStressExposure", () => {
  // Every real facility has a data/siting-context.json entry (enforced by
  // lib/siting-context.test.ts), so this exclusion can't be proven against
  // the real dataset — it would pass whether or not the implementation
  // actually excludes a missing entry. A synthetic fixture with a facility
  // id absent from the lookup is required to give the assertion real teeth.
  it("excludes a facility with no siting-context entry at all from rated (not counted as zero-stress)", () => {
    const noEntry = makeFacility({ id: "no-entry", status: "operational" });
    const lookup = makeLookup({}); // deliberately empty — "no-entry" has no key
    const result = computeWaterStressExposure([noEntry], lookup);
    expect(result).toEqual<WaterStressExposure>({ rated: 0, highOrExtreme: 0, extreme: 0 });
  });

  it("excludes a facility whose entry exists but has no waterStress field", () => {
    const noWaterStress = makeFacility({ id: "no-water-stress", status: "operational" });
    const lookup = makeLookup({
      "no-water-stress": { nearestWater: { name: "Some River", kind: "river", distanceMi: 1 } },
    });
    const result = computeWaterStressExposure([noWaterStress], lookup);
    expect(result).toEqual<WaterStressExposure>({ rated: 0, highOrExtreme: 0, extreme: 0 });
  });

  it("excludes a cancelled facility even though its basin is rated Extremely High", () => {
    const cancelled = makeFacility({ id: "cancelled-extreme", status: "cancelled" });
    const lookup = makeLookup({
      "cancelled-extreme": { waterStress: { cat: 4, label: "Extremely High (>80%)" } },
    });
    const result = computeWaterStressExposure([cancelled], lookup);
    expect(result).toEqual<WaterStressExposure>({ rated: 0, highOrExtreme: 0, extreme: 0 });
  });

  it('counts "Arid and Low Water Use" (cat -1) in rated but not in highOrExtreme', () => {
    const arid = makeFacility({ id: "arid", status: "operational" });
    const lookup = makeLookup({
      arid: { waterStress: { cat: -1, label: "Arid and Low Water Use" } },
    });
    const result = computeWaterStressExposure([arid], lookup);
    expect(result).toEqual<WaterStressExposure>({ rated: 1, highOrExtreme: 0, extreme: 0 });
  });

  it("a mixed fixture produces the right rated / highOrExtreme / extreme", () => {
    const low = makeFacility({ id: "low", status: "operational" });
    const high = makeFacility({ id: "high", status: "operational" });
    const extreme = makeFacility({ id: "extreme", status: "under_construction" });
    const unrated = makeFacility({ id: "unrated", status: "proposed" });
    const cancelledHigh = makeFacility({ id: "cancelled-high", status: "cancelled" });

    const lookup = makeLookup({
      low: { waterStress: { cat: 0, label: "Low (<10%)" } },
      high: { waterStress: { cat: 3, label: "High (40-80%)" } },
      extreme: { waterStress: { cat: 4, label: "Extremely High (>80%)" } },
      "cancelled-high": { waterStress: { cat: 3, label: "High (40-80%)" } },
      // "unrated" has no entry at all
    });

    const result = computeWaterStressExposure(
      [low, high, extreme, unrated, cancelledHigh],
      lookup
    );
    expect(result).toEqual<WaterStressExposure>({ rated: 3, highOrExtreme: 2, extreme: 1 });
  });
});

describe("getWaterStressExposure", () => {
  it("equals an independently-computed reduction over the real dataset and the real siting-context artifact", async () => {
    const facilities = (await getAllFacilities()).filter((f) => f.status !== "cancelled");
    let rated = 0;
    let highOrExtreme = 0;
    let extreme = 0;
    for (const f of facilities) {
      const waterStress = getSitingContext(f.id)?.waterStress;
      if (!waterStress) continue;
      rated++;
      if (waterStress.cat >= 3) {
        highOrExtreme++;
        if (waterStress.cat === 4) extreme++;
      }
    }
    expect(await getWaterStressExposure()).toEqual<WaterStressExposure>({
      rated,
      highOrExtreme,
      extreme,
    });
  });

  it("rated is at most the non-cancelled facility count, and extreme is at most highOrExtreme", async () => {
    const nonCancelledCount = (await getAllFacilities()).filter(
      (f) => f.status !== "cancelled"
    ).length;
    const result = await getWaterStressExposure();
    expect(result.rated).toBeLessThanOrEqual(nonCancelledCount);
    expect(result.highOrExtreme).toBeLessThanOrEqual(result.rated);
    expect(result.extreme).toBeLessThanOrEqual(result.highOrExtreme);
  });
});
