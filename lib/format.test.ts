import { describe, it, expect } from "vitest";
import {
  getFacilityMaxMw,
  formatCapacity,
  formatLocation,
  formatStatusLabel,
  formatUsdCompact,
  formatPower,
  formatMgd,
  formatTonsPerYear,
  formatEditionDate,
  stripLegalSuffix,
  isOperatorRedundant,
  nameConveysType,
} from "./format";
import type { DataCenterFacility } from "@/lib/schema";

/** Minimal data-center Facility stub — only the fields format.ts cares about. */
function makeFacility(
  overrides: Partial<DataCenterFacility> = {}
): DataCenterFacility {
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
      location: { lat: 35, lon: -90, city: "Memphis", state: "TN", precision: "exact" },
    });
    expect(formatLocation(f)).toBe("Memphis, TN");
  });

  it("returns only state when city is absent", () => {
    const f = makeFacility({
      location: { lat: 35, lon: -90, state: "TN", precision: "exact" },
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

// ---------------------------------------------------------------------------
// formatPower
// ---------------------------------------------------------------------------
describe("formatPower", () => {
  it("formats below the GW threshold as whole MW", () => {
    expect(formatPower(999)).toBe("999 MW");
  });

  it("formats at the GW threshold as 1.0 GW", () => {
    expect(formatPower(1000)).toBe("1.0 GW");
  });

  it("formats above the GW threshold as GW with one decimal", () => {
    expect(formatPower(2500)).toBe("2.5 GW");
  });

  it("rounds a fractional MW value below the threshold", () => {
    expect(formatPower(12.4)).toBe("12 MW");
  });
});

// ---------------------------------------------------------------------------
// formatMgd
// ---------------------------------------------------------------------------
describe("formatMgd", () => {
  it("formats a fractional MGD value with one decimal", () => {
    expect(formatMgd(3.25)).toBe("3.3 MGD");
  });

  it("formats a whole MGD value with a trailing .0", () => {
    expect(formatMgd(10)).toBe("10.0 MGD");
  });
});

// ---------------------------------------------------------------------------
// formatTonsPerYear
// ---------------------------------------------------------------------------
describe("formatTonsPerYear", () => {
  it("formats a fractional tonnage with thousands separators", () => {
    expect(formatTonsPerYear(245.5)).toBe("245.5 tons/yr");
  });

  it("formats a large tonnage with thousands separators", () => {
    expect(formatTonsPerYear(1_250_000)).toBe("1,250,000 tons/yr");
  });

  // Regression: a permit can legitimately state a 0.0 limit for a pollutant a
  // unit is prohibited from emitting. Collapsing that to an em dash or empty
  // string would misreport a real regulatory fact.
  it("formats 0 as '0 tons/yr', never an em dash or empty string", () => {
    expect(formatTonsPerYear(0)).toBe("0 tons/yr");
  });
});

// ---------------------------------------------------------------------------
// formatEditionDate
// ---------------------------------------------------------------------------
describe("formatEditionDate", () => {
  it("formats an ISO timestamp as a long-form date", () => {
    expect(formatEditionDate("2026-09-01T16:58:23.496Z")).toBe("September 1, 2026");
  });

  // Regression: getDatasetEdition's FALLBACK_EDITION returns the literal
  // string "unknown" for asOf when facilities.meta.json is missing or
  // malformed — this must degrade to a readable label, never "Invalid Date".
  it('falls back to "date unavailable" for the "unknown" sentinel', () => {
    expect(formatEditionDate("unknown")).toBe("date unavailable");
  });

  it("falls back to \"date unavailable\" for any other unparseable input", () => {
    expect(formatEditionDate("not-a-date")).toBe("date unavailable");
  });
});

// ---------------------------------------------------------------------------
// stripLegalSuffix
// ---------------------------------------------------------------------------
describe("stripLegalSuffix", () => {
  it("strips a comma-separated 'Inc.' suffix", () => {
    expect(stripLegalSuffix("CleanSpark, Inc.")).toBe("CleanSpark");
  });

  it("strips a space-separated 'Corporation' suffix", () => {
    expect(stripLegalSuffix("Applied Digital Corporation")).toBe("Applied Digital");
  });

  it("strips compound suffixes by looping until stable", () => {
    expect(stripLegalSuffix("Foo Holdings, LLC")).toBe("Foo");
  });

  it("leaves a name with no legal suffix unchanged", () => {
    expect(stripLegalSuffix("Google")).toBe("Google");
  });

  it("does not strip an unrelated word that merely ends in a suffix-like substring", () => {
    // "Sunoco" ends in "co" but it's not a comma/space-separated suffix token.
    expect(stripLegalSuffix("Sunoco")).toBe("Sunoco");
  });
});

// ---------------------------------------------------------------------------
// isOperatorRedundant
// ---------------------------------------------------------------------------
describe("isOperatorRedundant", () => {
  it("is true when the operator (after stripping 'Inc.') is embedded in the name", () => {
    // Regression: the raw strings share no substring because of ", Inc." —
    // without suffix-stripping this would be a false negative.
    expect(
      isOperatorRedundant("CleanSpark Dalton Bitcoin Mining Facility", "CleanSpark, Inc.")
    ).toBe(true);
  });

  it("is true when the operator (after stripping 'Corporation') is embedded in the name", () => {
    expect(
      isOperatorRedundant("Applied Digital Polaris Forge 1", "Applied Digital Corporation")
    ).toBe(true);
  });

  it("is true when the name is embedded in the operator (reverse direction)", () => {
    expect(isOperatorRedundant("Google Council Bluffs", "Google")).toBe(true);
  });

  it("is false for a genuinely distinct name and operator (no over-stripping)", () => {
    expect(isOperatorRedundant("Colossus", "xAI")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nameConveysType
// ---------------------------------------------------------------------------
describe("nameConveysType", () => {
  it("is true for a data_center name containing 'Data Center'", () => {
    expect(nameConveysType("Meta Prineville Data Center Campus", "data_center")).toBe(true);
  });

  it("is true for a crypto_mining name containing 'Mining'", () => {
    expect(
      nameConveysType("CleanSpark Dalton Bitcoin Mining Facility", "crypto_mining")
    ).toBe(true);
  });

  it("is true for a power_generation name containing 'Solar'", () => {
    expect(nameConveysType("Sunrise Solar Array", "power_generation")).toBe(true);
  });

  it("is false when the name says nothing about the facility type", () => {
    expect(nameConveysType("Colossus", "data_center")).toBe(false);
  });

  // A bare substring test suppressed the type label on any name that merely
  // CONTAINED a keyword inside a longer word. Zero facilities tripped it when
  // this shipped, so these pin the behaviour before a future record does.
  it("is false when a keyword is glued inside a longer word", () => {
    expect(nameConveysType("Windsor Energy Center", "power_generation")).toBe(false);
    expect(nameConveysType("Winding Creek Station", "power_generation")).toBe(false);
    expect(nameConveysType("Minerva Ridge Station", "crypto_mining")).toBe(false);
    expect(nameConveysType("Solaris Holdings Center", "power_generation")).toBe(false);
  });

  it("still matches a keyword used as a real word, including plurals", () => {
    expect(nameConveysType("Sunrise Wind Farm", "power_generation")).toBe(true);
    expect(nameConveysType("Ark Data Centers Marion", "data_center")).toBe(true);
    expect(nameConveysType("Compass Datacenters Lauderdale", "data_center")).toBe(true);
  });
});
