import { describe, it, expect } from "vitest";

import {
  hasEconomics,
  hasEmissions,
  hasEnergyWater,
  hasSubsidies,
  missingSectionLabels,
} from "./facility-gaps";
import type { DataCenterFacility, PowerGenerationFacility } from "@/lib/schema";

// ---------------------------------------------------------------------------
// The predicates behind the printed brief's consolidated nil line, and behind
// each section's own empty-state prompt. Both callers import THESE functions,
// so a disagreement between the summary and the page is a failure here rather
// than something a reader discovers on paper.
//
// Two real ids are used deliberately:
//   - `meta-prometheus-new-albany-oh` has an entry in data/siting-context.json
//     AND is listed in a power_generation record's `poweredFacilityIds`, so a
//     stub carrying that id exercises both cross-dataset predicates as true.
//   - `test-dc` is in neither, so the same predicates read false.
// Nothing here is mocked: these are the lookups the page itself performs.
// ---------------------------------------------------------------------------

/** Bare data-center stub: every optional section empty. */
function makeBare(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test Datacenter",
    operator: "Test Corp",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 40.0, lon: -90.0, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com/source",
        label: "Source",
        retrievedAt: "2024-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2024-06-01",
    ...overrides,
  };
}

/** Every section filled — including the two that depend on other datasets. */
function makeFull(): DataCenterFacility {
  return makeBare({
    id: "meta-prometheus-new-albany-oh",
    investmentUsd: 800_000_000,
    landAcres: 300,
    jobs: { permanent: 100 },
    energy: { source: "grid" },
    water: { coolingType: "closed_loop" },
    emissions: { permittedTpy: { nox: 12.5 } },
    subsidies: [{ program: "Data center sales-tax exemption", jurisdiction: "OH" }],
    stakeholders: [
      {
        name: "A. Person",
        role: "landowner",
        asOf: "2024-01-01",
        sourceIndex: 0,
      },
    ],
  });
}

const ALL_SEVEN = [
  "siting context",
  "power supply",
  "economic impact",
  "energy and water",
  "air permit",
  "public subsidies",
  "stakeholders",
];

describe("missingSectionLabels", () => {
  it("returns nothing for a facility with data in every section", async () => {
    expect(await missingSectionLabels(makeFull())).toEqual([]);
  });

  it("returns all seven, in the page's top-to-bottom order, for a bare record", async () => {
    expect(await missingSectionLabels(makeBare())).toEqual(ALL_SEVEN);
  });

  // Both cross-dataset sections at once: the only real id available with a
  // siting-context entry that is ALSO listed by a generator drops the two
  // together, so they can't be split across the parametrised cases below.
  it("drops the two dataset-backed sections for a record present in both", async () => {
    const missing = await missingSectionLabels(
      makeBare({ id: "meta-prometheus-new-albany-oh" })
    );

    expect(missing).toEqual(
      ALL_SEVEN.filter((l) => l !== "siting context" && l !== "power supply")
    );
  });

  it.each([
    ["economic impact", { landAcres: 295 }],
    ["energy and water", { energy: { source: "grid" as const } }],
    ["air permit", { emissions: { permittedTpy: { nox: 12.5 } } }],
    ["public subsidies", { subsidies: [{ program: "Test credit" }] }],
    [
      "stakeholders",
      {
        stakeholders: [
          { name: "A. Person", role: "landowner" as const, asOf: "2024-01-01", sourceIndex: 0 },
        ],
      },
    ],
  ])("drops only %s once that section has data", async (label, overrides) => {
    const missing = await missingSectionLabels(
      makeBare(overrides as Partial<DataCenterFacility>)
    );

    expect(missing).not.toContain(label);
    expect(missing).toEqual(ALL_SEVEN.filter((l) => l !== label));
  });

  // The empty-object hole: schema-valid, renders nothing, and must therefore
  // be NAMED as missing. Reported as present, the printed brief would assert
  // this record has air-permit data on a page that shows none.
  it("names air permit for a schema-valid but empty emissions object", async () => {
    const missing = await missingSectionLabels(makeBare({ emissions: {} }));

    expect(missing).toContain("air permit");
    expect(missing).toEqual(ALL_SEVEN);
  });

  // A generator's section is "Powers" — what it supplies — so printing
  // "power supply" there would name the wrong missing fact.
  it("names the power section for what it is on a power_generation record", async () => {
    const generator: PowerGenerationFacility = {
      id: "test-plant",
      name: "Test Plant",
      operator: "Test Power Co",
      status: "operational",
      facilityType: "power_generation",
      confidence: "confirmed",
      location: { lat: 40.0, lon: -90.0, city: "Springfield", state: "IL", precision: "exact" },
      statusHistory: [],
      sources: [
        {
          url: "https://example.com/source",
          label: "Source",
          retrievedAt: "2024-01-01",
          kind: "press",
        },
      ],
      lastUpdated: "2024-06-01",
    };

    expect(await missingSectionLabels(generator)).toContain("powered campuses");
    expect(await missingSectionLabels(generator)).not.toContain("power supply");

    // `generation.offtaker` alone satisfies the section (a company-level or
    // grid-region purchase with no single named campus), so it drops out.
    const withOfftaker: PowerGenerationFacility = {
      ...generator,
      generation: { technology: "natural_gas", offtaker: "Some Operator" },
    };
    expect(await missingSectionLabels(withOfftaker)).not.toContain("powered campuses");
  });
});

// ---------------------------------------------------------------------------
// The four predicates lifted out of components/facility/civic-impact.tsx.
// Each mirrors the guard that group renders its empty state on.
// ---------------------------------------------------------------------------

describe("civic-impact section predicates", () => {
  it("hasEconomics is true for any one of investment, land or jobs", () => {
    expect(hasEconomics(makeBare())).toBe(false);
    expect(hasEconomics(makeBare({ investmentUsd: 1 }))).toBe(true);
    expect(hasEconomics(makeBare({ landAcres: 295 }))).toBe(true);
    expect(hasEconomics(makeBare({ jobs: { permanent: 12 } }))).toBe(true);
  });

  it("hasEnergyWater is true for either energy or water", () => {
    expect(hasEnergyWater(makeBare())).toBe(false);
    expect(hasEnergyWater(makeBare({ energy: { source: "grid" } }))).toBe(true);
    expect(hasEnergyWater(makeBare({ water: { coolingType: "air" } }))).toBe(true);
  });

  // NOT a presence check on the object. `emissions: {}` is schema-valid
  // (every field optional, the superRefine only fires once permittedTpy has
  // a defined pollutant) and renders nothing, so reporting it as present
  // would have the printed summary contradict the page.
  it("hasEmissions requires renderable content, not merely the emissions object", () => {
    expect(hasEmissions(makeBare())).toBe(false);
    expect(hasEmissions(makeBare({ emissions: {} }))).toBe(false);
    // A citation with nothing to cite renders no panel — the group excludes
    // sourceIndex from its content test, so this predicate must too.
    expect(hasEmissions(makeBare({ emissions: { sourceIndex: 0 } }))).toBe(false);
  });

  it.each([
    // `!== undefined`, never truthy: a permitted 0.0 tpy limit is a real
    // regulatory fact the group renders, not an absence.
    ["a zero pollutant limit", { permittedTpy: { nox: 0 }, basis: "facility_wide" as const }],
    ["a pollutant limit", { permittedTpy: { nox: 12.5 }, basis: "facility_wide" as const }],
    ["permit metadata alone", { permitNumber: "AQP-1234" }],
    ["an enum field alone", { permitType: "title_v" as const }],
    ["notes alone", { notes: "Permit under appeal." }],
    // Groups-only permits (xAI/MZX MS) carry no facility-wide tonnage at all.
    [
      "unit groups alone",
      {
        unitGroups: [
          {
            label: "Turbine Group A",
            basis: "group_wide" as const,
            permittedTpy: { nox: 40 },
          },
        ],
      },
    ],
  ])("hasEmissions is true for %s", (_case, emissions) => {
    expect(hasEmissions(makeBare({ emissions }))).toBe(true);
  });

  it("hasSubsidies requires a non-empty array, not just the key", () => {
    expect(hasSubsidies(makeBare())).toBe(false);
    expect(hasSubsidies(makeBare({ subsidies: [] }))).toBe(false);
    expect(hasSubsidies(makeBare({ subsidies: [{ program: "Test credit" }] }))).toBe(true);
  });
});
