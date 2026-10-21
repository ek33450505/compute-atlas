import { describe, it, expect } from "vitest";

import {
  CORRECTABLE_KEYS,
  CORRECTABLE_FIELD_META,
  capacityGapField,
  capacityShownField,
  correctableDisplayValues,
} from "@/lib/contribute-fields";
import { formatCapacity } from "@/lib/format";
import type { DataCenterFacility } from "@/lib/schema";
import { STATUS_ORDER, type Status } from "@/lib/status";

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

// Regression guard for the correction dialog's "New value" options: it once
// rendered the status values for EVERY enum-kind field, so water/energy/
// community corrections always failed the server's enumValues check. The
// dialog now builds its options from enumValues + enumLabels, so each enum
// member needs a label or it would render as a raw key.
describe("enum-kind correctable fields carry display labels", () => {
  const enumMetas = CORRECTABLE_FIELD_META.filter((meta) => meta.valueKind === "enum");

  it("has the four enum-kind fields (status, water, energy, community)", () => {
    expect(enumMetas.map((meta) => meta.key)).toEqual(["status", "water", "energy", "community"]);
  });

  it.each(enumMetas.map((meta) => [meta.key, meta] as const))(
    "%s has a non-empty label for every enumValues member",
    (_key, meta) => {
      expect(meta.enumLabels).toBeDefined();
      expect(meta.enumValues?.length).toBeGreaterThan(0);
      for (const value of meta.enumValues ?? []) {
        expect(meta.enumLabels?.[value], `label for ${meta.key}:${value}`).toBeTruthy();
      }
    }
  );

  it("status enumValues equal STATUS_ORDER", () => {
    const meta = CORRECTABLE_FIELD_META.find((m) => m.key === "status");
    expect(meta?.enumValues).toEqual([...STATUS_ORDER]);
  });
});

/** Minimal data-center Facility; every optional field is omitted unless overridden. */
function makeFacility(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Source", retrievedAt: "2024-01-01", kind: "press" },
    ],
    lastUpdated: "2024-01-01",
    ...overrides,
  };
}

// The "Currently: …" line in the correction dialog reads from this. Display
// strings, not raw values, and a key is OMITTED (never "" or "undefined")
// when the facility has nothing for it.
describe("correctableDisplayValues", () => {
  it("renders every correctable field of a fully-populated facility as a display string", () => {
    const facility = makeFacility({
      name: "Colossus",
      operator: "xAI",
      status: "under_construction",
      poweredBy: "Grid — TVA",
      capacityMw: { operational: 1500, planned: 300000 },
      subsidies: [{ program: "Sales tax exemption" }, { amountUsd: 5_000_000 }],
      jobs: { permanent: 1200 },
      water: { coolingType: "closed_loop" },
      energy: { source: "on_site_gas" },
      emissions: { permitNumber: "TCEQ-1234" },
      community: { status: "contested" },
    });

    expect(correctableDisplayValues(facility)).toEqual({
      name: "Colossus",
      operator: "xAI",
      poweredBy: "Grid — TVA",
      status: "Under construction",
      state: "Tennessee",
      capacityOperationalMw: "1,500 MW",
      capacityPlannedMw: "300,000 MW",
      subsidies: "2 recorded",
      jobs: "1,200",
      water: "Closed-loop",
      energy: "On-site gas",
      emissions: "TCEQ-1234",
      community: "Contested",
    });
  });

  it("every correctable key has a display value", () => {
    const full = correctableDisplayValues(
      makeFacility({
        poweredBy: "Grid",
        capacityMw: { operational: 1, planned: 2 },
        subsidies: [{}],
        jobs: { permanent: 3 },
        water: { coolingType: "air" },
        energy: { source: "grid" },
        emissions: { permitNumber: "P-1" },
        community: { status: "supported" },
      })
    );
    expect(Object.keys(full).sort()).toEqual([...CORRECTABLE_KEYS].sort());
  });

  it("returns only the always-present fields for a facility with no optional data", () => {
    expect(correctableDisplayValues(makeFacility({ name: "Bare", operator: "Op" }))).toEqual({
      name: "Bare",
      operator: "Op",
      status: "Operational",
      state: "Tennessee",
    });
  });

  it("omits a field whose parent object exists but whose own value is unset", () => {
    const values = correctableDisplayValues(
      makeFacility({
        capacityMw: { planned: 400 },
        jobs: { construction: 900 },
        water: { reportedMgd: 1.2 },
        energy: { utility: "TVA" },
        community: { notes: "n/a" },
      })
    );
    expect(values).not.toHaveProperty("capacityOperationalMw");
    expect(values.capacityPlannedMw).toBe("400 MW");
    expect(values).not.toHaveProperty("jobs");
    expect(values).not.toHaveProperty("water");
    expect(values).not.toHaveProperty("energy");
    expect(values).not.toHaveProperty("community");
  });

  it("counts subsidies as records ('N recorded') and omits the key when there are none", () => {
    const one = correctableDisplayValues(makeFacility({ subsidies: [{ program: "A" }] }));
    expect(one.subsidies).toBe("1 recorded");

    const three = correctableDisplayValues(makeFacility({ subsidies: [{}, {}, {}] }));
    expect(three.subsidies).toBe("3 recorded");

    expect(correctableDisplayValues(makeFacility({ subsidies: [] }))).not.toHaveProperty("subsidies");
    expect(correctableDisplayValues(makeFacility())).not.toHaveProperty("subsidies");
  });

  it("names a territory, not just a state (Puerto Rico, not 'PR')", () => {
    const values = correctableDisplayValues(
      makeFacility({ location: { lat: 18.2, lon: -66.5, state: "PR", precision: "exact" } })
    );
    expect(values.state).toBe("Puerto Rico");
  });

  it("keeps a sourced zero: 0 permanent jobs is a recorded value, not an absent one", () => {
    expect(correctableDisplayValues(makeFacility({ jobs: { permanent: 0 } })).jobs).toBe("0");
  });

  it("falls back to the raw code for a jurisdiction it has no name for", () => {
    const values = correctableDisplayValues(
      makeFacility({ location: { lat: 0, lon: 0, state: "ZZ", precision: "exact" } })
    );
    expect(values.state).toBe("ZZ");
  });
});

describe("capacityGapField", () => {
  // Typed as Record<Status, …> so a new status fails typecheck here until
  // someone decides which capacity it publishes. Only an operating site has an
  // operational figure to fill; every other status, cancelled included, is planned.
  const EXPECTED: Record<Status, "capacityPlannedMw" | "capacityOperationalMw"> = {
    operational: "capacityOperationalMw",
    under_construction: "capacityPlannedMw",
    permitted: "capacityPlannedMw",
    proposed: "capacityPlannedMw",
    cancelled: "capacityPlannedMw",
  };

  it.each(STATUS_ORDER.map((status) => [status, EXPECTED[status]] as const))(
    "%s -> %s",
    (status, field) => {
      expect(capacityGapField(status)).toBe(field);
    }
  );
});

describe("capacityShownField", () => {
  it("targets operational when operational capacity is recorded", () => {
    expect(capacityShownField({ capacityMw: { operational: 150 } })).toBe("capacityOperationalMw");
  });

  it("targets operational when both are recorded (the figure shown is operational)", () => {
    expect(capacityShownField({ capacityMw: { operational: 100, planned: 400 } })).toBe(
      "capacityOperationalMw"
    );
  });

  it("targets planned when only planned capacity is recorded", () => {
    expect(capacityShownField({ capacityMw: { planned: 1200 } })).toBe("capacityPlannedMw");
  });

  it("targets planned when no capacity is recorded", () => {
    expect(capacityShownField({ capacityMw: undefined })).toBe("capacityPlannedMw");
  });

  // The point of the helper: "No" must correct the figure the page SHOWED.
  // Figures >= 1,000 on purpose: a thousands separator is where two formatters
  // would disagree, and a sub-1,000 figure can never show it.
  it.each([
    ["operational only", { operational: 1500 }],
    ["planned only", { planned: 12000 }],
    ["both", { operational: 1500, planned: 24000 }],
  ])("targets the field formatCapacity displays (%s)", (_name, capacityMw) => {
    const facility = makeFacility({ capacityMw });
    const field = capacityShownField(facility);
    const shown = correctableDisplayValues(facility)[field];

    expect(shown).toBeDefined();
    expect(formatCapacity(facility)).toContain(shown);
  });
});
