import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import sitingContextRaw from "@/data/siting-context.json";
import { splitRiskLabel, type SitingContext } from "./siting-context";

describe("splitRiskLabel", () => {
  it("splits a label with a trailing parenthetical detail", () => {
    expect(splitRiskLabel("Extremely High (>80%)")).toEqual({
      category: "Extremely High",
      detail: ">80%",
    });
  });

  it("splits a label with a hyphenated range detail", () => {
    expect(splitRiskLabel("High (4-8 cm/y)")).toEqual({
      category: "High",
      detail: "4-8 cm/y",
    });
  });

  it("returns no detail when the label has no parenthetical", () => {
    expect(splitRiskLabel("Extremely High")).toEqual({
      category: "Extremely High",
    });
  });

  it("trims surrounding whitespace from category and detail", () => {
    expect(splitRiskLabel("  Medium  ( 20-40% ) ")).toEqual({
      category: "Medium",
      detail: "20-40%",
    });
  });
});

describe("data-integrity: siting-context coverage", () => {
  // Only forward coverage (facility -> siting entry) is asserted here.
  // The reverse is expected and legitimate: retiring a facility requires a
  // raw Neon delete (see CLAUDE.md) that leaves a stale siting-context entry
  // behind on purpose. Do NOT add an orphan-entry assertion — that would
  // break retirements, not catch a real bug.
  it("has a data/siting-context.json entry for every facility in data/facilities.json", () => {
    const sitingIds = new Set(Object.keys(sitingContextRaw));
    const missingIds = (facilitiesRaw as Array<{ id: string }>)
      .map((facility) => facility.id)
      .filter((id) => !sitingIds.has(id));

    if (missingIds.length > 0) {
      const shown = missingIds.slice(0, 20);
      const more = missingIds.length - shown.length;
      const suffix = more > 0 ? `, and ${more} more` : "";
      throw new Error(
        `${missingIds.length} facilit${missingIds.length === 1 ? "y is" : "ies are"} missing ` +
          `from data/siting-context.json: ${shown.join(", ")}${suffix}. ` +
          "This happens when a data wave runs db:export but skips `npm run build:mapdata` " +
          "before committing. Run `npm run build:mapdata` and commit the regenerated " +
          "data/siting-context.json. " +
          "It can also happen after build:mapdata HAS run: a facility may match no siting " +
          "dataset at all (NHD, HIFLD, Aqueduct and the USGS principal aquifers are " +
          "CONUS-only, so a non-CONUS point can miss every one). That is not an excuse to " +
          "omit it — scripts/build-map-data.mjs must still record `{}` for such a facility.",
      );
    }

    expect(missingIds).toEqual([]);
  });
});

describe("data-integrity: NHD backfill debt", () => {
  // NHD, HIFLD, WRI Aqueduct and the USGS principal aquifers are all CONUS-only,
  // so these jurisdictions can never match and are not debt.
  const NON_CONUS = new Set(["HI", "AK", "GU", "MP", "PR", "VI"]);

  // Ratchet. This is a DEBT, not a target: every --skip-nhd wave raises it and a
  // successful full `npm run build:mapdata` should drive it to 0. Changing this
  // number must be a deliberate, reviewed edit — four consecutive waves grew this
  // debt silently because nothing asserted it.
  // 141 -> 155 on 2026-09-25: the 5th consecutive --skip-nhd wave (+14 Illinois
  // facilities, PR #348). NHD was scattered-degraded, not down — the quorum
  // pre-flight correctly aborted the full pass at [PA northeast] while the old
  // single-coordinate probe would have passed and ground for hours.
  const NHD_BACKFILL_DEBT_CEILING = 155;

  // `FacilityStateRow` is the minimal facility shape the debt count needs.
  // stateById/missingNearestWaterOffenders both take optional injected data
  // (defaulting to the real imported JSON) so the orphan-regression test below
  // can exercise a synthetic orphan id without mutating
  // facilitiesRaw/sitingContextRaw — the real dataset has zero orphans today
  // (2228/2228, 1:1), so there is no way to hit that path against it directly.
  // Every production assertion in this file calls these with no arguments,
  // which resolves to the defaults below and keeps reading off the real
  // imported JSON unchanged.
  type FacilityStateRow = { id: string; location: { state: string } };

  function stateById(
    facilities: FacilityStateRow[] = facilitiesRaw as FacilityStateRow[],
  ): Map<string, string> {
    const map = new Map<string, string>();
    for (const facility of facilities) {
      map.set(facility.id, facility.location.state);
    }
    return map;
  }

  function missingNearestWaterOffenders(
    facilities: FacilityStateRow[] = facilitiesRaw as FacilityStateRow[],
    sitingContext: Record<string, SitingContext> = sitingContextRaw as Record<
      string,
      SitingContext
    >,
  ): Array<{ id: string; state: string }> {
    const stateMap = stateById(facilities);
    const offenders: Array<{ id: string; state: string }> = [];

    for (const [id, entry] of Object.entries(sitingContext)) {
      if (entry.nearestWater !== undefined) continue; // has it - not debt

      // An ORPHAN (siting entry with no facility) is not debt: it has no page, so
      // it renders no partial panel. Retiring a facility takes a raw Neon delete
      // that deliberately leaves the entry behind (see CLAUDE.md), which is why
      // the coverage test above asserts forward coverage only. Counting orphans
      // would make a pure-retirement wave churn the ceiling for the wrong reason.
      const state = stateMap.get(id);
      if (state === undefined) continue;

      if (NON_CONUS.has(state)) continue; // CONUS-only datasets can't match here

      offenders.push({ id, state });
    }

    return offenders;
  }

  function perStateBreakdown(offenders: Array<{ id: string; state: string }>): string {
    const counts = new Map<string, number>();
    for (const { state } of offenders) {
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([state, count]) => `${state}: ${count}`)
      .join(", ");
  }

  it("does not silently exceed the NHD backfill debt ceiling", () => {
    const offenders = missingNearestWaterOffenders();

    if (offenders.length > NHD_BACKFILL_DEBT_CEILING) {
      throw new Error(
        `${offenders.length} facilities are missing nearestWater in data/siting-context.json, ` +
          `exceeding NHD_BACKFILL_DEBT_CEILING (${NHD_BACKFILL_DEBT_CEILING}). ` +
          `Per-state breakdown of offending ids: ${perStateBreakdown(offenders)}. ` +
          "A `--skip-nhd` wave is the usual cause, though not the only possible one; " +
          "if the growth was intentional, raise NHD_BACKFILL_DEBT_CEILING in " +
          "lib/siting-context.test.ts in the same PR so the growth is reviewed.",
      );
    }

    expect(offenders.length).toBeLessThanOrEqual(NHD_BACKFILL_DEBT_CEILING);
  });

  it("flags when debt is paid down, so the ceiling can be ratcheted lower", () => {
    const offenders = missingNearestWaterOffenders();

    if (offenders.length < NHD_BACKFILL_DEBT_CEILING) {
      throw new Error(
        `NHD backfill debt has DROPPED to ${offenders.length} (ceiling is ` +
          `${NHD_BACKFILL_DEBT_CEILING}). Before lowering the ceiling, check which of two ` +
          "things caused the drop: either the debt was genuinely backfilled by a full " +
          "`npm run build:mapdata` run — in which case lower NHD_BACKFILL_DEBT_CEILING to " +
          `${offenders.length} in lib/siting-context.test.ts so the ratchet keeps its teeth ` +
          "— or NON_CONUS was widened to exclude a state with real offenders, which only " +
          "narrows what this test measures and pays down no debt at all (the membership " +
          "test below pins NON_CONUS against exactly that). A stale high ceiling silently " +
          "re-permits regrowth, so don't leave it high by default — but don't lower it to " +
          "paper over a narrowed measurement either.",
      );
    }

    expect(offenders.length).toBeGreaterThanOrEqual(NHD_BACKFILL_DEBT_CEILING);
  });

  it("keeps NON_CONUS scoped to exactly the six CONUS-excluded jurisdictions", () => {
    // Widening this set is the cheapest way to make a failing debt test above
    // pass without paying down any real debt: every added state's offenders
    // would be silently excluded instead of fixed. Pin the exact membership so
    // that route is closed off.
    expect(Array.from(NON_CONUS).sort()).toEqual(["AK", "GU", "HI", "MP", "PR", "VI"]);
  });

  it("does not count an orphan (siting entry with no matching facility) as debt", () => {
    // Regression test for a reviewer-flagged bug: an id present in
    // siting-context.json but absent from facilities.json used to fall back to
    // state "(unknown)", which is not in NON_CONUS, so it was miscounted as
    // debt. An orphan has no facility page, so it never renders a partial
    // "Siting context" panel — it isn't debt. Retiring a facility takes a raw
    // Neon delete that deliberately leaves a stale siting entry behind (see
    // CLAUDE.md and the coverage-test comment above), so this is a sanctioned
    // case, not an error state.
    //
    // The real dataset has zero orphans today (2228/2228, 1:1), so this can
    // only be exercised with injected data — hence
    // missingNearestWaterOffenders() takes optional facilities/sitingContext
    // params instead of this test mutating the imported JSON. Every
    // production test above calls it with no arguments and keeps reading off
    // the real data unchanged.
    const facilities: FacilityStateRow[] = [{ id: "known-1", location: { state: "TX" } }];
    const sitingContext: Record<string, SitingContext> = {
      "known-1": {}, // real facility, missing nearestWater -> IS debt
      "orphan-1": {}, // no matching facility -> must NOT be counted as debt
    };

    const offenders = missingNearestWaterOffenders(facilities, sitingContext);

    expect(offenders).toEqual([{ id: "known-1", state: "TX" }]);
  });
});
