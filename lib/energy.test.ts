import { describe, it, expect } from "vitest";
import { COOLING_TYPE_ENTRIES, COOLING_TYPE_DISPLAYED } from "./energy";
import { waterCoolingTypeEnum } from "./schema";

describe("COOLING_TYPE_ENTRIES", () => {
  it("has exactly the keys COOLING_TYPE_DISPLAYED marks `true` — no extras, none missing", () => {
    const displayedKeys = Object.entries(COOLING_TYPE_DISPLAYED)
      .filter(([, displayed]) => displayed)
      .map(([key]) => key)
      .sort();
    expect(COOLING_TYPE_ENTRIES.map((e) => e.key).sort()).toEqual(displayedKeys);
  });

  it("keys, plus the deliberately-excluded types, cover every waterCoolingTypeEnum member", () => {
    // Runtime companion to COOLING_TYPE_DISPLAYED's compile-time
    // `satisfies Record<CoolingType, boolean>` guard in lib/energy.ts: that
    // guard proves every CoolingType has SOME true/false assignment, but
    // can't prove COOLING_TYPE_ENTRIES actually matches it. This closes that
    // gap directly against the canonical enum.
    const excluded = Object.entries(COOLING_TYPE_DISPLAYED)
      .filter(([, displayed]) => !displayed)
      .map(([key]) => key);
    const combined = [...COOLING_TYPE_ENTRIES.map((e) => e.key), ...excluded].sort();
    expect(combined).toEqual([...waterCoolingTypeEnum.options].sort());
  });

  it("excludes 'unknown' deliberately, not by omission", () => {
    expect(COOLING_TYPE_DISPLAYED.unknown).toBe(false);
    expect(COOLING_TYPE_ENTRIES.map((e) => e.key)).not.toContain("unknown");
  });
});
