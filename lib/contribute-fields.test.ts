import { describe, it, expect } from "vitest";

import { CORRECTABLE_KEYS, CORRECTABLE_FIELD_META } from "@/lib/contribute-fields";

// Regression guard for the staged CORRECTABLE_KEYS rollout (2026-09-10): Ed
// approved widening the original 7 correctable fields to include subsidies,
// jobs, water, energy, emissions, community, and stakeholders in principle,
// but only subsidies and jobs shipped this pass — the rest are deferred to a
// fast-follow PR once review volume on these two is known. This test exists
// so a future edit that adds one of the deferred keys (or accidentally drops
// one of the two shipped ones) fails loudly instead of silently widening the
// public correction surface.
const DEFERRED_KEYS = ["water", "energy", "emissions", "community", "stakeholders"];

describe("CORRECTABLE_KEYS staged rollout", () => {
  it("has exactly 9 keys: the original 7 plus subsidies and jobs", () => {
    expect(CORRECTABLE_KEYS).toHaveLength(9);
  });

  it("includes the two newly-shipped keys", () => {
    expect(CORRECTABLE_KEYS).toContain("subsidies");
    expect(CORRECTABLE_KEYS).toContain("jobs");
  });

  it("does not include any deferred field", () => {
    for (const deferred of DEFERRED_KEYS) {
      expect(CORRECTABLE_KEYS).not.toContain(deferred);
    }
  });

  it("keeps CORRECTABLE_FIELD_META in sync with CORRECTABLE_KEYS (same keys, same order)", () => {
    expect(CORRECTABLE_FIELD_META.map((meta) => meta.key)).toEqual([...CORRECTABLE_KEYS]);
  });

  it("types the two new fields as number-valued (a single checkable figure)", () => {
    const subsidiesMeta = CORRECTABLE_FIELD_META.find((meta) => meta.key === "subsidies");
    const jobsMeta = CORRECTABLE_FIELD_META.find((meta) => meta.key === "jobs");
    expect(subsidiesMeta?.valueKind).toBe("number");
    expect(jobsMeta?.valueKind).toBe("number");
  });
});
