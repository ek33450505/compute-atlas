import { describe, it, expect } from "vitest";

import type { Facility, Source, StatusEvent } from "@/lib/schema";
import { selectRecordSpecimen } from "@/lib/data";

// `selectRecordSpecimen` is a pure function of the list it is handed — it takes
// no `loadFacilities()` of its own — so this file needs none of the DB mocking
// the other lib/data.*.test.ts files set up.

function makeSources(n: number): Source[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/source-${i}`,
    label: `Source ${i}`,
    retrievedAt: "2026-01-01",
    kind: "press" as const,
  }));
}

function makeHistory(n: number): StatusEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    status: "proposed" as const,
    date: `2025-0${i + 1}`,
  }));
}

function makeFacility(
  overrides: Partial<Facility> & { id: string } & {
    sourceCount?: number;
    historyCount?: number;
  }
): Facility {
  const { sourceCount = 3, historyCount = 2, ...rest } = overrides;
  return {
    name: `Facility ${overrides.id}`,
    operator: "Test Operator",
    status: "proposed",
    confidence: "reported",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, state: "IL", precision: "exact" },
    capacityMw: { planned: 100 },
    statusHistory: makeHistory(historyCount),
    sources: makeSources(sourceCount),
    lastUpdated: "2026-01-01",
    ...rest,
  } as Facility;
}

describe("selectRecordSpecimen", () => {
  it("picks the highest-capacity facility that clears the bar", () => {
    const facilities = [
      makeFacility({ id: "small", capacityMw: { planned: 100 } }),
      makeFacility({ id: "big", capacityMw: { planned: 10000 } }),
      makeFacility({ id: "medium", capacityMw: { planned: 4500 } }),
    ];

    expect(selectRecordSpecimen(facilities)?.id).toBe("big");
  });

  it("ranks on the LARGER of operational and planned capacity", () => {
    const facilities = [
      // Larger planned figure: ranks at 900, not at its 100 MW operational.
      makeFacility({ id: "mostly-planned", capacityMw: { operational: 100, planned: 900 } }),
      makeFacility({ id: "all-operational", capacityMw: { operational: 500 } }),
    ];

    expect(selectRecordSpecimen(facilities)?.id).toBe("mostly-planned");
  });

  it("excludes facilities with fewer than 3 sources", () => {
    const facilities = [
      makeFacility({ id: "two-sources", capacityMw: { planned: 10000 }, sourceCount: 2 }),
      makeFacility({ id: "three-sources", capacityMw: { planned: 100 }, sourceCount: 3 }),
    ];

    expect(selectRecordSpecimen(facilities)?.id).toBe("three-sources");
  });

  it("excludes facilities with fewer than 2 status-history events", () => {
    // This is the term that stops the timeline rendering as a single dot — the
    // reason the plan's bare "highest capacity with >= 3 sources" was not enough.
    const facilities = [
      makeFacility({ id: "one-event", capacityMw: { planned: 10000 }, historyCount: 1 }),
      makeFacility({ id: "no-events", capacityMw: { planned: 9000 }, historyCount: 0 }),
      makeFacility({ id: "two-events", capacityMw: { planned: 100 }, historyCount: 2 }),
    ];

    expect(selectRecordSpecimen(facilities)?.id).toBe("two-events");
  });

  it("excludes facilities with no disclosed capacity", () => {
    const facilities = [
      makeFacility({ id: "undisclosed", capacityMw: undefined }),
      makeFacility({ id: "empty-capacity", capacityMw: {} }),
      makeFacility({ id: "disclosed", capacityMw: { planned: 50 } }),
    ];

    expect(selectRecordSpecimen(facilities)?.id).toBe("disclosed");
  });

  it("accepts a facility carrying exactly the minimum on every term", () => {
    const facilities = [
      makeFacility({
        id: "exactly-minimum",
        capacityMw: { planned: 1 },
        sourceCount: 3,
        historyCount: 2,
      }),
    ];

    expect(selectRecordSpecimen(facilities)?.id).toBe("exactly-minimum");
  });

  // --- Determinism ---------------------------------------------------------

  it("breaks a capacity tie on source count, descending", () => {
    const facilities = [
      makeFacility({ id: "aaa-fewer", capacityMw: { planned: 10000 }, sourceCount: 3 }),
      makeFacility({ id: "zzz-more", capacityMw: { planned: 10000 }, sourceCount: 7 }),
    ];

    // Not "first in the list" and not "lowest id" — the source-count term wins.
    expect(selectRecordSpecimen(facilities)?.id).toBe("zzz-more");
  });

  it("breaks a capacity AND source-count tie on id, ascending", () => {
    const tied = [
      makeFacility({ id: "zulu", capacityMw: { planned: 10000 }, sourceCount: 5 }),
      makeFacility({ id: "alpha", capacityMw: { planned: 10000 }, sourceCount: 5 }),
      makeFacility({ id: "mike", capacityMw: { planned: 10000 }, sourceCount: 5 }),
    ];

    expect(selectRecordSpecimen(tied)?.id).toBe("alpha");
    // Input order cannot change the winner.
    expect(selectRecordSpecimen([...tied].reverse())?.id).toBe("alpha");
  });

  it("does not mutate the caller's array", () => {
    const facilities = [
      makeFacility({ id: "small", capacityMw: { planned: 100 } }),
      makeFacility({ id: "big", capacityMw: { planned: 10000 } }),
    ];
    const orderBefore = facilities.map((f) => f.id);

    selectRecordSpecimen(facilities);

    expect(facilities.map((f) => f.id)).toEqual(orderBefore);
  });

  // --- Degradation ---------------------------------------------------------

  it("returns null for an empty dataset rather than throwing", () => {
    expect(selectRecordSpecimen([])).toBeNull();
  });

  it("returns null when no facility clears the bar", () => {
    const facilities = [
      makeFacility({ id: "thin-sources", sourceCount: 1 }),
      makeFacility({ id: "thin-history", historyCount: 0 }),
      makeFacility({ id: "no-capacity", capacityMw: undefined }),
    ];

    expect(selectRecordSpecimen(facilities)).toBeNull();
  });
});

describe("selectRecordSpecimen against the bundled dataset", () => {
  it("pins a single record that satisfies every term of the rule", async () => {
    const { getAllFacilities } = await import("@/lib/data");
    const facilities = await getAllFacilities();
    const specimen = selectRecordSpecimen(facilities);

    // Guards the live rendering path: the homepage must actually get a
    // specimen out of the real data, and it must be one the component can
    // render (>= 3 citations, >= 2 timeline events, a capacity to print).
    expect(specimen).not.toBeNull();
    expect(specimen!.sources.length).toBeGreaterThanOrEqual(3);
    expect(specimen!.statusHistory.length).toBeGreaterThanOrEqual(2);
    expect(
      Math.max(
        specimen!.capacityMw?.operational ?? 0,
        specimen!.capacityMw?.planned ?? 0
      )
    ).toBeGreaterThan(0);
  });
});
