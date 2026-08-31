import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Facility, DataCenterFacility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest — mirrors the mocking
// pattern in lib/data.getFacilitiesByMetro.test.ts. Mocking the DB-client
// boundary (rather than "@/lib/data" itself) lets a swapped-out
// loadFacilities be seen by the ranking helpers' own internal call to it.
vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => true,
  readsUseDatabase: () => true,
  getDb: () => mockDb,
}));

let fixtureFacilities: DataCenterFacility[] = [];

/** Minimal drizzle-query-builder stand-in — mirrors lib/data.getFacilitiesByMetro.test.ts. */
function makeMockDb() {
  return {
    select: () => ({
      from: () => Promise.resolve(fixtureFacilities.map((doc) => ({ id: doc.id, doc }))),
    }),
  };
}

const mockDb = makeMockDb();

/** Mirrors the makeFacility fixture factory in lib/data.getFacilitiesByMetro.test.ts. */
function makeFacility(
  overrides: Partial<DataCenterFacility> & {
    id: string;
    name: string;
    state: string;
    operator?: string;
    capacityMw?: Facility["capacityMw"];
  }
): DataCenterFacility {
  const { state, capacityMw, operator, ...rest } = overrides;
  return {
    facilityType: "data_center",
    operator: operator ?? "Test Operator",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 35, lon: -90, state, precision: "exact" },
    capacityMw,
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Source", retrievedAt: "2024-01-01", kind: "press" },
    ],
    lastUpdated: "2024-01-01",
    ...rest,
  };
}

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import {
  getFacilitiesRankedByPlannedMw,
  getTopOperatorsByCapacity,
  getTopStatesByCapacity,
} from "@/lib/data";

describe("capacity-ranking helpers (outlier sanity guard)", () => {
  beforeEach(() => {
    fixtureFacilities = [];
  });

  describe("getFacilitiesRankedByPlannedMw", () => {
    it("sorts by planned MW desc, tie-broken by name A→Z", async () => {
      fixtureFacilities = [
        makeFacility({ id: "b", name: "Bravo", state: "TX", capacityMw: { planned: 500 } }),
        makeFacility({ id: "a", name: "Alpha", state: "TX", capacityMw: { planned: 500 } }),
        makeFacility({ id: "big", name: "Big Site", state: "OH", capacityMw: { planned: 900 } }),
      ];
      const result = await getFacilitiesRankedByPlannedMw(10);
      expect(result.map((f) => f.id)).toEqual(["big", "a", "b"]);
    });

    it("excludes non-cancelled facilities with no positive planned MW", async () => {
      fixtureFacilities = [
        makeFacility({ id: "zero", name: "Zero", state: "TX", capacityMw: { planned: 0 } }),
        makeFacility({ id: "none", name: "None", state: "TX" }),
        makeFacility({ id: "op-only", name: "Op Only", state: "TX", capacityMw: { operational: 200 } }),
        makeFacility({ id: "keep", name: "Keep", state: "TX", capacityMw: { planned: 300 } }),
      ];
      const result = await getFacilitiesRankedByPlannedMw(10);
      expect(result.map((f) => f.id)).toEqual(["keep"]);
    });

    it("excludes cancelled facilities even with a large planned figure", async () => {
      fixtureFacilities = [
        makeFacility({
          id: "cancelled",
          name: "Cancelled Site",
          state: "TX",
          status: "cancelled",
          capacityMw: { planned: 800 },
        }),
        makeFacility({ id: "live", name: "Live Site", state: "TX", capacityMw: { planned: 300 } }),
      ];
      const result = await getFacilitiesRankedByPlannedMw(10);
      expect(result.map((f) => f.id)).toEqual(["live"]);
    });

    it("respects the n parameter and defaults to 20", async () => {
      fixtureFacilities = Array.from({ length: 25 }, (_, i) =>
        makeFacility({
          id: `f${i}`,
          name: `Facility ${i}`,
          state: "TX",
          capacityMw: { planned: 100 + i },
        })
      );
      expect((await getFacilitiesRankedByPlannedMw()).length).toBe(20);
      expect((await getFacilitiesRankedByPlannedMw(5)).length).toBe(5);
    });

    it("excludes a rumored 8,000 MW outlier from the ranking (hard guard)", async () => {
      fixtureFacilities = [
        makeFacility({
          id: "outlier",
          name: "Unverified Megasite",
          state: "UT",
          confidence: "rumored",
          capacityMw: { planned: 8000 },
        }),
        makeFacility({ id: "real", name: "Real Campus", state: "UT", capacityMw: { planned: 400 } }),
      ];
      const result = await getFacilitiesRankedByPlannedMw(10);
      expect(result.map((f) => f.id)).toEqual(["real"]);
    });

    it("does NOT exclude a confirmed facility above 2,000 MW planned", async () => {
      fixtureFacilities = [
        makeFacility({
          id: "confirmed-big",
          name: "Confirmed Megasite",
          state: "TX",
          confidence: "confirmed",
          capacityMw: { planned: 2500 },
        }),
      ];
      const result = await getFacilitiesRankedByPlannedMw(10);
      expect(result.map((f) => f.id)).toEqual(["confirmed-big"]);
    });
  });

  describe("getTopOperatorsByCapacity", () => {
    it("sums operational/planned MW per operator across non-cancelled facilities, sorted by combined total desc", async () => {
      fixtureFacilities = [
        makeFacility({
          id: "a1",
          name: "A1",
          state: "TX",
          operator: "Acme",
          capacityMw: { operational: 100, planned: 50 },
        }),
        makeFacility({
          id: "a2",
          name: "A2",
          state: "OH",
          operator: "Acme",
          capacityMw: { operational: 0, planned: 200 },
        }),
        makeFacility({
          id: "b1",
          name: "B1",
          state: "VA",
          operator: "Beta",
          capacityMw: { operational: 500 },
        }),
      ];
      const result = await getTopOperatorsByCapacity(10);
      expect(result).toEqual([
        { operator: "Beta", operationalMw: 500, plannedMw: 0, count: 1 },
        { operator: "Acme", operationalMw: 100, plannedMw: 250, count: 2 },
      ]);
    });

    it("excludes cancelled facilities' MW from the sum but still counts them", async () => {
      fixtureFacilities = [
        makeFacility({
          id: "live",
          name: "Live",
          state: "TX",
          operator: "Acme",
          capacityMw: { operational: 100 },
        }),
        makeFacility({
          id: "cancelled",
          name: "Cancelled",
          state: "TX",
          operator: "Acme",
          status: "cancelled",
          capacityMw: { operational: 900, planned: 900 },
        }),
      ];
      const result = await getTopOperatorsByCapacity(10);
      expect(result).toEqual([{ operator: "Acme", operationalMw: 100, plannedMw: 0, count: 2 }]);
    });

    it("ties are broken by operator A→Z", async () => {
      fixtureFacilities = [
        makeFacility({ id: "z", name: "Z", state: "TX", operator: "Zulu", capacityMw: { operational: 100 } }),
        makeFacility({ id: "a", name: "A", state: "TX", operator: "Alpha", capacityMw: { operational: 100 } }),
      ];
      const result = await getTopOperatorsByCapacity(10);
      expect(result.map((r) => r.operator)).toEqual(["Alpha", "Zulu"]);
    });

    it("excludes a rumored 8,000 MW outlier operator's facility entirely, including from its count", async () => {
      fixtureFacilities = [
        makeFacility({
          id: "outlier",
          name: "Unverified Megasite",
          state: "UT",
          operator: "Outlier Corp",
          confidence: "rumored",
          capacityMw: { planned: 8000 },
        }),
        makeFacility({
          id: "real",
          name: "Real Campus",
          state: "UT",
          operator: "Real Operator",
          capacityMw: { operational: 300 },
        }),
      ];
      const result = await getTopOperatorsByCapacity(10);
      expect(result.map((r) => r.operator)).toEqual(["Real Operator"]);
      expect(result.find((r) => r.operator === "Outlier Corp")).toBeUndefined();
    });

    it("respects the n parameter and defaults to 10", async () => {
      fixtureFacilities = Array.from({ length: 15 }, (_, i) =>
        makeFacility({
          id: `f${i}`,
          name: `Facility ${i}`,
          state: "TX",
          operator: `Operator ${i}`,
          capacityMw: { operational: 100 + i },
        })
      );
      expect((await getTopOperatorsByCapacity()).length).toBe(10);
      expect((await getTopOperatorsByCapacity(3)).length).toBe(3);
    });
  });

  describe("getTopStatesByCapacity", () => {
    it("sums operational/planned MW per state across non-cancelled facilities, sorted by combined total desc", async () => {
      fixtureFacilities = [
        makeFacility({ id: "tx1", name: "TX1", state: "TX", capacityMw: { operational: 200 } }),
        makeFacility({ id: "tx2", name: "TX2", state: "TX", capacityMw: { planned: 100 } }),
        makeFacility({ id: "oh1", name: "OH1", state: "OH", capacityMw: { operational: 50 } }),
      ];
      const result = await getTopStatesByCapacity(10);
      expect(result).toEqual([
        { state: "TX", operationalMw: 200, plannedMw: 100, count: 2 },
        { state: "OH", operationalMw: 50, plannedMw: 0, count: 1 },
      ]);
    });

    it("excludes a rumored 8,000 MW outlier from the facility ranking AND from its state's summed total, while the state's other legitimate facilities still count", async () => {
      fixtureFacilities = [
        // The outlier: >2,000 MW planned, confidence "rumored" — must be dropped.
        makeFacility({
          id: "ut-outlier",
          name: "Unverified UT Megasite",
          state: "UT",
          confidence: "rumored",
          capacityMw: { planned: 8000 },
        }),
        // Several legitimate confirmed/reported UT facilities that must still count.
        makeFacility({
          id: "ut-real-1",
          name: "UT Real Campus 1",
          state: "UT",
          confidence: "confirmed",
          capacityMw: { operational: 150, planned: 50 },
        }),
        makeFacility({
          id: "ut-real-2",
          name: "UT Real Campus 2",
          state: "UT",
          confidence: "reported",
          capacityMw: { planned: 300 },
        }),
      ];

      // Facility ranking excludes the outlier entirely.
      const ranked = await getFacilitiesRankedByPlannedMw(10);
      expect(ranked.map((f) => f.id)).not.toContain("ut-outlier");
      expect(ranked.map((f) => f.id).sort()).toEqual(["ut-real-1", "ut-real-2"]);

      // The state's summed total excludes the outlier's 8,000 MW but still
      // reflects the two legitimate facilities (150 operational + 350 planned).
      const stateRanking = await getTopStatesByCapacity(10);
      expect(stateRanking).toEqual([{ state: "UT", operationalMw: 150, plannedMw: 350, count: 2 }]);
    });

    it("ties are broken by state A→Z", async () => {
      fixtureFacilities = [
        makeFacility({ id: "z", name: "Z", state: "WY", capacityMw: { operational: 100 } }),
        makeFacility({ id: "a", name: "A", state: "AK", capacityMw: { operational: 100 } }),
      ];
      const result = await getTopStatesByCapacity(10);
      expect(result.map((r) => r.state)).toEqual(["AK", "WY"]);
    });

    it("respects the n parameter and defaults to 10", async () => {
      fixtureFacilities = Array.from({ length: 15 }, (_, i) =>
        makeFacility({
          id: `f${i}`,
          name: `Facility ${i}`,
          state: `S${i}`,
          capacityMw: { operational: 100 + i },
        })
      );
      expect((await getTopStatesByCapacity()).length).toBe(10);
      expect((await getTopStatesByCapacity(4)).length).toBe(4);
    });
  });
});
