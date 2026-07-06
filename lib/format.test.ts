import { describe, it, expect } from "vitest";
import {
  getFacilityMaxMw,
  formatCapacity,
  formatLocation,
  formatStatusLabel,
  formatUsdCompact,
} from "./format";
import type { Facility } from "@/lib/schema";

/** Minimal Facility stub — only the fields format.ts cares about. */
function makeFacility(
  overrides: Partial<Facility> = {}
): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: "operational",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN" },
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getFacilityMaxMw
// ---------------------------------------------------------------------------
describe("getFacilityMaxMw", () => {
  it("returns operational when only operational is present", () => {
    const f = makeFacility({ capacityMw: { operational: 150 } });
    expect(getFacilityMaxMw(f)).toBe(150);
  });

  it("returns planned when only planned is present", () => {
    const f = makeFacility({ capacityMw: { planned: 1200 } });
    expect(getFacilityMaxMw(f)).toBe(1200);
  });

  it("returns the larger value when both are present", () => {
    const f = makeFacility({ capacityMw: { operational: 100, planned: 400 } });
    expect(getFacilityMaxMw(f)).toBe(400);
  });

  it("returns undefined when capacityMw is absent", () => {
    const f = makeFacility({ capacityMw: undefined });
    expect(getFacilityMaxMw(f)).toBeUndefined();
  });

  it("returns undefined when capacityMw is present but both fields are absent", () => {
    // capacityMw: {} is valid per schema (planned and operational are both optional)
    const f = makeFacility({ capacityMw: {} });
    expect(getFacilityMaxMw(f)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatCapacity
// ---------------------------------------------------------------------------
describe("formatCapacity", () => {
  it("formats operational capacity without 'planned' suffix", () => {
    const f = makeFacility({ capacityMw: { operational: 150 } });
    expect(formatCapacity(f)).toBe("150 MW");
  });

  it("formats planned-only capacity with 'planned' suffix", () => {
    const f = makeFacility({ capacityMw: { planned: 1200 } });
    expect(formatCapacity(f)).toBe("1,200 MW planned");
  });

  it("prefers operational over planned when both are present", () => {
    const f = makeFacility({ capacityMw: { operational: 100, planned: 400 } });
    expect(formatCapacity(f)).toBe("100 MW");
  });

  it("returns em dash when no capacity data", () => {
    const f = makeFacility({ capacityMw: undefined });
    expect(formatCapacity(f)).toBe("—");
  });

  it("uses toLocaleString thousands separator for large values", () => {
    const f = makeFacility({ capacityMw: { planned: 10000 } });
    // The exact separator depends on locale; check it contains the digits and units
    const result = formatCapacity(f);
    expect(result).toMatch(/10[,.]?000 MW planned/);
  });
});

// ---------------------------------------------------------------------------
// formatLocation
// ---------------------------------------------------------------------------
describe("formatLocation", () => {
  it("returns City, ST when city is present", () => {
    const f = makeFacility({
      location: { lat: 35, lon: -90, city: "Memphis", state: "TN" },
    });
    expect(formatLocation(f)).toBe("Memphis, TN");
  });

  it("returns only state when city is absent", () => {
    const f = makeFacility({
      location: { lat: 35, lon: -90, state: "TN" },
    });
    expect(formatLocation(f)).toBe("TN");
  });
});

// ---------------------------------------------------------------------------
// formatUsdCompact
// ---------------------------------------------------------------------------
describe("formatUsdCompact", () => {
  it("formats billions with one decimal digit", () => {
    expect(formatUsdCompact(3_500_000_000)).toBe("$3.5B");
  });

  it("formats hundreds of millions without a decimal", () => {
    expect(formatUsdCompact(450_000_000)).toBe("$450M");
  });

  it("formats millions with one decimal digit", () => {
    expect(formatUsdCompact(2_900_000)).toBe("$2.9M");
  });
});

// ---------------------------------------------------------------------------
// formatStatusLabel
// ---------------------------------------------------------------------------
describe("formatStatusLabel", () => {
  it("returns 'Operational' for operational", () => {
    expect(formatStatusLabel("operational")).toBe("Operational");
  });

  it("returns 'Under construction' for under_construction", () => {
    expect(formatStatusLabel("under_construction")).toBe("Under construction");
  });

  it("returns 'Permitted' for permitted", () => {
    expect(formatStatusLabel("permitted")).toBe("Permitted");
  });

  it("returns 'Proposed' for proposed", () => {
    expect(formatStatusLabel("proposed")).toBe("Proposed");
  });

  it("returns 'Cancelled' for cancelled", () => {
    expect(formatStatusLabel("cancelled")).toBe("Cancelled");
  });
});
