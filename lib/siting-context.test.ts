import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import nhdDebtLedgerRaw from "@/data/nhd-backfill-debt.json";
import sitingContextRaw from "@/data/siting-context.json";
import {
  missingNearestWaterOffenders,
  NON_CONUS,
  parseLedger,
  perStateBreakdown,
  type FacilityStateRow,
} from "./nhd-debt";
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
  // NON_CONUS and the offender/breakdown helpers live in ./nhd-debt so
  // scripts/update-nhd-debt.ts counts exactly what this ratchet counts. The
  // production assertions below always read the real imported JSON; only the
  // orphan-regression test injects synthetic data, because the real dataset has
  // zero orphans today (2228/2228, 1:1) and there is no way to hit that path
  // against it directly.
  //
  // Ratchet. This is a DEBT, not a target: every --skip-nhd wave raises it and a
  // successful full `npm run build:mapdata` should drive it to 0. Changing the
  // ceiling must be a deliberate, reviewed edit — four consecutive waves grew this
  // debt silently because nothing asserted it.
  //
  // The ceiling now lives in data/nhd-backfill-debt.json and is rewritten by
  // `npx tsx scripts/update-nhd-debt.ts --note "<why>"`; its `note` carries the
  // reason for the latest change. The history below is what was recorded here while
  // the ceiling was a literal in this file (last set to 52 in #375, 2026-10-02) —
  // newer entries live in the ledger's `note` and in git history.
  // 141 -> 155 on 2026-09-25: the 5th consecutive --skip-nhd wave (+14 Illinois
  // facilities, PR #348). NHD was scattered-degraded, not down — the quorum
  // pre-flight correctly aborted the full pass at [PA northeast] while the old
  // single-coordinate probe would have passed and ground for hours.
  // 155 -> 158 on 2026-09-28: the 6th consecutive --skip-nhd wave (PR #359, the
  // AL/AK approvals). The debt is exactly the 3 ALABAMA records; the 5 Alaska
  // ones in the same wave are non-CONUS and never counted. NHD was DOWN, not
  // merely slow: build:mapdata's own pre-flight timed out on layers 4 and 10 at
  // [KS interior] (12s budget, both aborted) and refused the full pass, and the
  // script's own message prescribed --skip-nhd. This is the documented fallback
  // being used as documented, not a shortcut.
  // 158 -> 177 on 2026-09-29: the 7th consecutive --skip-nhd wave (PR #363, the
  // AR/CA approvals). The debt is exactly the 19 newly added records: 14
  // Arkansas + 5 California, every one CONUS and every one missing
  // nearestWater. NHD was SCATTERED-DEGRADED, not down — a different shape
  // from the 2026-09-28 entry above, and the reason the full pass is not
  // merely worth retrying: measured locally over two samples of
  // spread-coordinate probes, 17 of 34 layer probes failed on the 12s budget
  // while others answered normally, and three successes took 6.1-7.7s against
  // the 473ms healthy baseline. Yet one full round of three spread
  // coordinates came back green and fast (260-1064ms) mid-sample, which is
  // exactly why a green pre-flight is a Bernoulli trial and not a health
  // verdict. The workflow's own quorum pre-flight aborted
  // the full pass at [KS interior] layers 4 and 10 (neon-sync run
  // 36608012700), which is what discarded the map artifacts and left the PR
  // red.
  // 177 -> 0 on 2026-09-29: the stage-2 backfill, `build:mapdata --
  // --backfill-nhd`, run by hand once NHD answered the quorum pre-flight
  // (all 10 probes ok, 240-607ms). It queried only the 201 facilities whose
  // entry lacked nearestWater (177 CONUS + 24 non-CONUS) at ~0.72/sec and
  // filled all 177; the 24 non-CONUS ids still legitimately lack it. At a
  // ceiling of 0 the floor test below can no longer fire, which is correct:
  // there is no debt left to pay down, and the ceiling test alone now fails
  // the moment a --skip-nhd wave leaves any new CONUS record without
  // nearestWater.
  //
  // Raised 0 -> 3 on 2026-09-30: USGS NHD failed the build:mapdata pre-flight
  // twice (layers 4 and 10 timed out at 12s), so the Bartow County, GA wave
  // (Stiles Road, Brown Farm Road, Switch Cartersville) shipped via
  // --skip-nhd. Pay it down with `build:mapdata` once NHD is healthy — the FULL
  // run, not --backfill-nhd, because the same wave also moved two pins
  // (Project Bunkhouse, Project Springbank) whose nearestWater and
  // nearestTransmission are still computed from the old coordinates, and only
  // the full path re-queries a facility that already has an entry. Lower this
  // back to 0 in that PR; the floor test below forces it.
  //
  // Raised 3 -> 22 on 2026-09-30: the CT/CO wave (PR #372, 19 new records:
  // 10 CO + 9 CT, all CONUS) shipped via --skip-nhd as well. The full pass
  // cleared the 5-coordinate quorum pre-flight (all 10 probes ok, 303-1034ms),
  // then NHD degraded mid-run — HTTP 504s, throughput fell to 0.0406
  // facilities/sec at 250/2290, projecting 13.9h — and the throughput guard
  // aborted it before anything was written. The payoff is unchanged from the
  // entry above and is still the FULL run (the two moved GA pins still need a
  // re-query); it now also takes the 19 CT/CO ids, 22 -> 0. Lower this to 0
  // in that PR.
  //
  // Raised 22 -> 38 on 2026-10-01: the DE/DC wave (PR #374, 16 new records:
  // 13 DE + 3 DC, all CONUS) shipped via --skip-nhd. NHD failed the quorum
  // pre-flight at [KS interior] in CI (neon-sync run 36905711567, layers 4
  // and 10 timed out at 12s), and again when re-probed by hand. The payoff is
  // still the FULL run, now 38 -> 0. Lower this to 0 in that PR.
  //
  // Raised 38 -> 52 on 2026-10-02: the FL/HI wave (PR #375, 22 new records:
  // 14 FL + 8 HI) shipped via --skip-nhd. Only the 14 FL records count; HI is
  // outside NHD's CONUS coverage (see NON_CONUS). NHD failed the quorum
  // pre-flight at [KS interior] in CI (neon-sync run 37045992336, layer 4
  // HTTP 502), and twice more when re-probed by hand (layer 4 timed out at
  // [KS interior]; both layers timed out at [PA northeast]). The payoff is
  // still the FULL run, now 52 -> 0. Lower this to 0 in that PR.
  //
  // Lowered 52 -> 0 on 2026-10-04: a FULL build:mapdata ran with NHD healthy
  // (off-peak, 10/10 quorum probes ok at 300-407ms, ~1.1 facilities/sec over
  // all 2,328). check-siting-additive: 0 lost, 0 nulled, 4 changed — the two
  // moved GA pins (Bunkhouse, Springbank) re-queried at their corrected
  // coordinates. All 52 owed CONUS ids now carry nearestWater.
  const NHD_BACKFILL_DEBT_CEILING = parseLedger(nhdDebtLedgerRaw).ceiling;

  const realOffenders = () =>
    missingNearestWaterOffenders(
      facilitiesRaw as FacilityStateRow[],
      sitingContextRaw as Record<string, SitingContext>,
    );

  const RATCHET_REMEDY =
    'run `npx tsx scripts/update-nhd-debt.ts --note "<why>"` in the same PR ' +
    "(it rewrites data/nhd-backfill-debt.json) so the change is reviewed.";

  it("does not silently exceed the NHD backfill debt ceiling", () => {
    const offenders = realOffenders();

    if (offenders.length > NHD_BACKFILL_DEBT_CEILING) {
      throw new Error(
        `${offenders.length} facilities are missing nearestWater in data/siting-context.json, ` +
          `exceeding the NHD backfill debt ceiling in data/nhd-backfill-debt.json (${NHD_BACKFILL_DEBT_CEILING}). ` +
          `Per-state breakdown of offending ids: ${perStateBreakdown(offenders)}. ` +
          "A `--skip-nhd` wave is the usual cause, though not the only possible one; " +
          `if the growth was intentional, ${RATCHET_REMEDY}`,
      );
    }

    expect(offenders.length).toBeLessThanOrEqual(NHD_BACKFILL_DEBT_CEILING);
  });

  it("flags when debt is paid down, so the ceiling can be ratcheted lower", () => {
    const offenders = realOffenders();

    if (offenders.length < NHD_BACKFILL_DEBT_CEILING) {
      throw new Error(
        `NHD backfill debt has DROPPED to ${offenders.length} (the ceiling in ` +
          `data/nhd-backfill-debt.json is ${NHD_BACKFILL_DEBT_CEILING}). Before lowering the ceiling, check which of two ` +
          "things caused the drop: either the debt was genuinely backfilled by " +
          "`npm run build:mapdata` (a full run or `-- --backfill-nhd`) — in which case " +
          `${RATCHET_REMEDY} It will record ${offenders.length} so the ratchet keeps its teeth ` +
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
    // missingNearestWaterOffenders() takes facilities/sitingContext as params
    // instead of this test mutating the imported JSON. Every production test
    // above reads off the real data unchanged.
    const facilities: FacilityStateRow[] = [{ id: "known-1", location: { state: "TX" } }];
    const sitingContext: Record<string, SitingContext> = {
      "known-1": {}, // real facility, missing nearestWater -> IS debt
      "orphan-1": {}, // no matching facility -> must NOT be counted as debt
    };

    const offenders = missingNearestWaterOffenders(facilities, sitingContext);

    expect(offenders).toEqual([{ id: "known-1", state: "TX" }]);
  });
});
