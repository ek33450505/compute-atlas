import { describe, it, expect } from "vitest";

import { CORRECTABLE_KEYS, CORRECTABLE_FIELD_META } from "@/lib/contribute-fields";

// Regression guard for the CORRECTABLE_KEYS widening (2026-09-11, Ed's fresh
// go-ahead): the original staged rollout (2026-09-10) shipped only subsidies
// and jobs, deferring water/energy/emissions/community/stakeholders pending
// real review volume. That volume is now known; Ed approved widening further
// to add water/energy/emissions/community. `stakeholders` stays excluded —
// see the CORRECTABLE_KEYS doc comment in lib/contribute-fields.ts for why
// (a public correction cannot safely name a specific real person). This test
// exists so a future edit that adds stakeholders (or drops one of the four
// newly-shipped keys) fails loudly instead of silently widening/narrowing the
// public correction surface.
const NEWLY_SHIPPED_KEYS = ["water", "energy", "emissions", "community"];

describe("CORRECTABLE_KEYS widened rollout", () => {
  it("has exactly 13 keys: the original 9 plus water/energy/emissions/community", () => {
    expect(CORRECTABLE_KEYS).toHaveLength(13);
  });

  it("includes the four newly-shipped keys", () => {
    for (const key of NEWLY_SHIPPED_KEYS) {
      expect(CORRECTABLE_KEYS).toContain(key);
    }
  });

  it("still does not include stakeholders", () => {
    expect(CORRECTABLE_KEYS).not.toContain("stakeholders");
  });

  it("keeps CORRECTABLE_FIELD_META in sync with CORRECTABLE_KEYS (same keys, same order)", () => {
    expect(CORRECTABLE_FIELD_META.map((meta) => meta.key)).toEqual([...CORRECTABLE_KEYS]);
  });

  it("types the two original-rollout fields as number-valued (a single checkable figure)", () => {
    const subsidiesMeta = CORRECTABLE_FIELD_META.find((meta) => meta.key === "subsidies");
    const jobsMeta = CORRECTABLE_FIELD_META.find((meta) => meta.key === "jobs");
    expect(subsidiesMeta?.valueKind).toBe("number");
    expect(jobsMeta?.valueKind).toBe("number");
  });

  it("types water/energy/community as enum-valued with non-empty enumValues", () => {
    for (const key of ["water", "energy", "community"]) {
      const meta = CORRECTABLE_FIELD_META.find((m) => m.key === key);
      expect(meta?.valueKind).toBe("enum");
      expect(meta?.enumValues?.length).toBeGreaterThan(0);
    }
  });

  it("types emissions as text-valued (permit number, not a tonnage)", () => {
    const meta = CORRECTABLE_FIELD_META.find((m) => m.key === "emissions");
    expect(meta?.valueKind).toBe("text");
  });
});
