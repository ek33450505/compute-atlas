import { describe, it, expect } from "vitest";

import {
  hasEconomics,
  hasEmissions,
  hasEnergyWater,
  hasSubsidies,
  firstCorrectableField,
  missingRecordItems,
  missingSectionLabels as missingSectionLabelsFor,
} from "./facility-gaps";
import sitingContextRaw from "@/data/siting-context.json";
import type { SitingContext } from "@/lib/siting-context";
import type { DataCenterFacility, PowerGenerationFacility } from "@/lib/schema";

/** Production passes the page's single siting read; here it is the snapshot entry. */
function missingSectionLabels(f: DataCenterFacility | PowerGenerationFacility): Promise<string[]> {
  return missingSectionLabelsFor(f, sitingFor(f));
}

/** The siting entry the page passes in: the bundled snapshot mirrors the Neon rows. */
function sitingFor(f: { id: string }): SitingContext | undefined {
  return (sitingContextRaw as Record<string, SitingContext>)[f.id];
}

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

  // An owned operator makes the page's Stakeholders section render (its
  // "Through the operator" group), but that is not a site-level record: the
  // brief must keep saying stakeholders are not recorded for the site.
  it("keeps 'stakeholders' in the list for an owned operator with no site-level stakeholder", async () => {
    const missing = await missingSectionLabels(makeBare({ operator: "QTS Data Centers" }));

    expect(missing).toContain("stakeholders");
    expect(missing).toEqual(ALL_SEVEN);
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

// ---------------------------------------------------------------------------
// missingRecordItems — the list behind the page's one "What this record is
// missing" card. It must name exactly what the retired on-screen prompts
// asked for, in page order, from the same predicates as the print summary.
// ---------------------------------------------------------------------------
describe("missingRecordItems", () => {
  /** Full AND with every field-level slot filled, so nothing is missing. */
  function makeComplete(): DataCenterFacility {
    return {
      ...makeFull(),
      capacityMw: { operational: 150 },
      poweredBy: "Grid",
      announcedDate: "2024-01-01",
      energy: { source: "grid", onSiteGenerationMw: 0 },
      water: { coolingType: "closed_loop", reportedMgd: 1 },
    };
  }

  const SITING = { nearestWater: { name: "X", kind: "river", distanceMi: 1 } } as SitingContext;
  const labels = (items: { label: string }[]) => items.map((i) => i.label);
  const itemsFor = (f: DataCenterFacility | PowerGenerationFacility, power = true) =>
    missingRecordItems(f, sitingFor(f), power);

  it("returns nothing for a complete record", () => {
    expect(itemsFor(makeComplete())).toEqual([]);
  });

  it("lists every section of a sparse record, in page order, with short labels", () => {
    // Capacity, announced date and siting are present, as on the sparse
    // reference record; a civic datum (community) keeps the section rendering.
    const f = makeBare({
      capacityMw: { operational: 10 },
      announcedDate: "2024-01-01",
      community: { status: "mixed" },
    });
    const items = missingRecordItems(f, SITING, false);

    expect(labels(items)).toEqual([
      "who powers it",
      "economic impact (jobs, investment)",
      "energy or water data",
      "air permit",
      "public subsidy",
      "a documented stakeholder",
    ]);
    expect(items.find((i) => i.label === "who powers it")?.field).toBe("poweredBy");
    expect(items.find((i) => i.label === "public subsidy")?.field).toBe("subsidies");
  });

  it("lists field-level gaps inside populated groups (rich record shape)", () => {
    const f = {
      ...makeComplete(),
      energy: { source: "grid" as const },
      water: { coolingType: "closed_loop" as const },
      emissions: undefined,
      stakeholders: undefined,
    };

    expect(itemsFor(f)).toEqual([
      { field: "energy.onSiteGenerationMw", label: "on-site generation capacity" },
      { field: "water.reportedMgd", label: "reported water use" },
      { label: "air permit" },
      { label: "a documented stakeholder" },
    ]);
  });

  it("does not list on-site generation when it is marked not recorded", () => {
    const f = {
      ...makeComplete(),
      energy: { source: "grid" as const },
      notRecorded: { "energy.onSiteGenerationMw": "No public figure." },
    };
    expect(labels(itemsFor(f))).not.toContain("on-site generation capacity");
  });

  it.each([
    ["investment", { landAcres: 5, jobs: { permanent: 1 } }, { field: "investmentUsd", label: "investment amount" }],
    ["land", { investmentUsd: 5, jobs: { permanent: 1 } }, { field: "landAcres", label: "land area" }],
    ["jobs", { investmentUsd: 5, landAcres: 5 }, { field: "jobs", label: "jobs" }],
  ])("lists a missing %s inside a populated economics group, and only it", (_n, econ, expected) => {
    const f = { ...makeComplete(), investmentUsd: undefined, landAcres: undefined, jobs: undefined, ...econ };
    expect(itemsFor(f)).toEqual([expected]);
  });

  it("lists capacity and announced date, and respects a marked capacity", () => {
    const f = { ...makeComplete(), capacityMw: undefined, announcedDate: undefined };
    expect(itemsFor(f)).toEqual([
      { field: "capacityOperationalMw", label: "capacity" },
      { field: "announcedDate", label: "announcement date" },
    ]);
    const marked = { ...f, notRecorded: { "capacityMw.operational": "x" } };
    expect(labels(itemsFor(marked))).toEqual(["announcement date"]);
  });

  describe("power item", () => {
    it("says who powers it when poweredBy is missing, whether or not links exist", () => {
      const f = { ...makeComplete(), poweredBy: undefined };
      expect(itemsFor(f, true)).toEqual([{ field: "poweredBy", label: "who powers it" }]);
      expect(itemsFor(f, false)).toEqual([{ field: "poweredBy", label: "who powers it" }]);
    });

    it("says 'power supply' when poweredBy is set but no generator links exist", () => {
      expect(itemsFor(makeComplete(), false)).toEqual([{ label: "power supply" }]);
    });

    it("names what a generator powers, and still asks who powers it", () => {
      const gen = {
        ...makeBare(),
        id: "test-plant",
        facilityType: "power_generation" as const,
        capacityMw: { operational: 1 },
        announcedDate: "2024-01-01",
      } as unknown as PowerGenerationFacility;
      expect(labels(missingRecordItems(gen, SITING, false))).toEqual(
        expect.arrayContaining(["who powers it", "what it powers"])
      );
      expect(labels(missingRecordItems({ ...gen, poweredBy: "self" }, SITING, true))).not.toContain(
        "what it powers"
      );
    });
  });

  // The card and the print line must never contradict: every section the
  // print summary names has to appear on the card, in the card's wording for
  // THAT record. `hasLinks` is the page's own input (what a generator-link
  // lookup returns), chosen per fixture rather than read back from print.
  describe("agrees with missingSectionLabels", () => {
    const generator = {
      ...makeBare(),
      id: "test-plant",
      facilityType: "power_generation" as const,
      capacityMw: { operational: 1 },
      announcedDate: "2024-01-01",
      poweredBy: "self",
    } as unknown as PowerGenerationFacility;

    // [name, facility, hasLinks, card label expected for the print power section]
    const fixtures: [
      string,
      DataCenterFacility | PowerGenerationFacility,
      boolean,
      string | null,
    ][] = [
      ["bare (no civic data at all)", makeBare(), false, "who powers it"],
      ["community only", makeBare({ community: { status: "mixed" } }), false, "who powers it"],
      ["energy only", makeBare({ energy: { source: "grid" } }), false, "who powers it"],
      ["marked energy/water only", makeBare({ notRecorded: { "energy.source": "No figure." } }), false, "who powers it"],
      ["empty emissions object", makeBare({ emissions: {} }), false, "who powers it"],
      ["poweredBy set, no generator links", makeBare({ poweredBy: "Grid" }), false, "power supply"],
      ["generator, no links", generator, false, "what it powers"],
      ["operator with owners, no site stakeholder", makeBare({ operator: "QTS Data Centers" }), false, "who powers it"],
      ["complete", makeComplete(), true, null],
    ];

    const POWER_SECTIONS = ["power supply", "powered campuses"];
    const CARD_FOR_SECTION: Record<string, string> = {
      "siting context": "siting context",
      "economic impact": "economic impact (jobs, investment)",
      "energy and water": "energy or water data",
      "air permit": "air permit",
      "public subsidies": "public subsidy",
      stakeholders: "a documented stakeholder",
    };

    it.each(fixtures)("%s", async (_n, f, hasLinks, powerLabel) => {
      const sections = await missingSectionLabelsFor(f, sitingFor(f), hasLinks);
      const items = labels(missingRecordItems(f, sitingFor(f), hasLinks));

      for (const section of sections.filter((x) => !POWER_SECTIONS.includes(x))) {
        expect(items, `print names "${section}"`).toContain(CARD_FOR_SECTION[section]);
      }
      // Power: the card names it exactly when print does, with the right wording.
      expect(sections.some((x) => POWER_SECTIONS.includes(x)) || f.poweredBy === undefined).toBe(
        powerLabel !== null
      );
      if (powerLabel) expect(items).toContain(powerLabel);
      else expect(items.some((l) => ["who powers it", "power supply", "what it powers"].includes(l))).toBe(false);
    });
  });
});

describe("firstCorrectableField", () => {
  it("returns the first item whose field the dialog can pre-select", () => {
    expect(
      firstCorrectableField([{ label: "a" }, { field: "investmentUsd", label: "b" }, { field: "jobs", label: "c" }])
    ).toBe("jobs");
  });

  it("returns undefined when none is correctable", () => {
    expect(firstCorrectableField([{ label: "a" }, { field: "announcedDate", label: "b" }])).toBeUndefined();
  });
});
