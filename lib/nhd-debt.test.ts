import { describe, it, expect } from "vitest";
import {
  DEFAULT_LEDGER_NOTE,
  missingNearestWaterOffenders,
  NON_CONUS,
  parseLedger,
  perStateBreakdown,
  planLedgerUpdate,
  type FacilityStateRow,
} from "./nhd-debt";

const WATER = { name: "Some Creek", distanceKm: 1.2 };

describe("missingNearestWaterOffenders", () => {
  const facilities: FacilityStateRow[] = [
    { id: "tx-missing", location: { state: "TX" } },
    { id: "tx-has-water", location: { state: "TX" } },
    { id: "hi-missing", location: { state: "HI" } },
    { id: "ga-missing", location: { state: "GA" } },
  ];

  it("counts a CONUS facility whose entry lacks nearestWater", () => {
    expect(missingNearestWaterOffenders(facilities, { "tx-missing": {} })).toEqual([
      { id: "tx-missing", state: "TX" },
    ]);
  });

  it("does not count an entry that has nearestWater", () => {
    expect(missingNearestWaterOffenders(facilities, { "tx-has-water": { nearestWater: WATER } })).toEqual([]);
  });

  it("skips non-CONUS states, which can never match NHD", () => {
    expect(missingNearestWaterOffenders(facilities, { "hi-missing": {} })).toEqual([]);
  });

  it("skips an orphan (siting entry with no matching facility)", () => {
    expect(missingNearestWaterOffenders(facilities, { "retired-1": {} })).toEqual([]);
  });

  it("returns only the real offenders from a mixed set", () => {
    const offenders = missingNearestWaterOffenders(facilities, {
      "tx-missing": {},
      "tx-has-water": { nearestWater: WATER },
      "hi-missing": {},
      "ga-missing": {},
      "retired-1": {},
    });
    expect(offenders).toEqual([
      { id: "tx-missing", state: "TX" },
      { id: "ga-missing", state: "GA" },
    ]);
  });

  it("pins NON_CONUS to exactly the six CONUS-excluded jurisdictions", () => {
    expect(Array.from(NON_CONUS).sort()).toEqual(["AK", "GU", "HI", "MP", "PR", "VI"]);
  });
});

describe("perStateBreakdown", () => {
  it("orders by count descending, then state ascending", () => {
    const offenders = [
      { id: "a", state: "GA" },
      { id: "b", state: "FL" },
      { id: "c", state: "FL" },
      { id: "d", state: "AL" },
    ];
    expect(perStateBreakdown(offenders)).toBe("FL: 2, AL: 1, GA: 1");
  });

  it("is empty for no offenders", () => {
    expect(perStateBreakdown([])).toBe("");
  });
});

describe("parseLedger", () => {
  it("accepts a well-formed ledger", () => {
    expect(parseLedger({ ceiling: 52, asOf: "2026-10-02", note: "x" })).toEqual({
      ceiling: 52,
      asOf: "2026-10-02",
      note: "x",
    });
  });

  it("accepts a ceiling of zero", () => {
    expect(parseLedger({ ceiling: 0, asOf: "2026-10-02", note: "" }).ceiling).toBe(0);
  });

  it.each([
    ["a string ceiling", { ceiling: "52" }],
    ["a fractional ceiling", { ceiling: 5.5 }],
    ["a negative ceiling", { ceiling: -1 }],
    ["a missing ceiling", { asOf: "2026-10-02" }],
    ["null", null],
    ["an array", [52]],
    ["a bare number", 52],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseLedger(raw)).toThrow(/malformed/);
  });
});

describe("planLedgerUpdate", () => {
  const ledger = { ceiling: 52, asOf: "2026-10-02", note: "earlier note" };

  it("writes nothing when the count equals the ceiling, so asOf does not churn", () => {
    expect(planLedgerUpdate(52, ledger, "ignored note", "2026-10-09")).toEqual({
      previous: 52,
      next: null,
    });
  });

  it("returns a new ledger dated today when the debt grew", () => {
    expect(planLedgerUpdate(60, ledger, "FL/HI wave via --skip-nhd", "2026-10-09")).toEqual({
      previous: 52,
      next: { ceiling: 60, asOf: "2026-10-09", note: "FL/HI wave via --skip-nhd" },
    });
  });

  it("returns a new ledger dated today when the debt was paid down", () => {
    expect(planLedgerUpdate(0, ledger, "full build:mapdata run", "2026-10-09")).toEqual({
      previous: 52,
      next: { ceiling: 0, asOf: "2026-10-09", note: "full build:mapdata run" },
    });
  });

  it("falls back to the default note when none is given", () => {
    expect(planLedgerUpdate(53, ledger, undefined, "2026-10-09").next?.note).toBe(DEFAULT_LEDGER_NOTE);
  });

  it("does not mutate the ledger it was given", () => {
    planLedgerUpdate(60, ledger, "x", "2026-10-09");
    expect(ledger).toEqual({ ceiling: 52, asOf: "2026-10-02", note: "earlier note" });
  });

  it("writes a missing ledger (ceiling unknown) with previous null", () => {
    expect(planLedgerUpdate(52, undefined, undefined, "2026-10-09")).toEqual({
      previous: null,
      next: { ceiling: 52, asOf: "2026-10-09", note: DEFAULT_LEDGER_NOTE },
    });
  });

  it("throws on a malformed ledger rather than overwriting it", () => {
    expect(() => planLedgerUpdate(52, { ceiling: "52" }, undefined, "2026-10-09")).toThrow(/malformed/);
    expect(() => planLedgerUpdate(52, null, undefined, "2026-10-09")).toThrow(/malformed/);
  });
});
