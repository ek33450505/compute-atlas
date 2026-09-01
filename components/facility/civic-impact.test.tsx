import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CivicImpactSection, hasCivicImpact } from "./civic-impact";
import type { DataCenterFacility, CryptoMiningFacility } from "@/lib/schema";

/** Minimal data-center Facility stub with required fields. */
function makeFacility(
  overrides: Partial<DataCenterFacility> = {}
): DataCenterFacility {
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
        url: "https://example.com/subsidy-source",
        label: "Subsidy Source",
        retrievedAt: "2024-01-01",
        kind: "subsidy",
      },
      {
        url: "https://example.com/community-source",
        label: "Community Report",
        retrievedAt: "2024-02-01",
        kind: "press",
      },
    ],
    lastUpdated: "2024-06-01",
    ...overrides,
  };
}

/** Minimal crypto_mining Facility stub with required fields. */
function makeMiningFacility(
  overrides: Partial<CryptoMiningFacility> = {}
): CryptoMiningFacility {
  return {
    id: "test-mining",
    name: "Test Mining Facility",
    operator: "Test Mining Corp",
    status: "operational",
    facilityType: "crypto_mining",
    confidence: "confirmed",
    location: { lat: 30.0, lon: -97.0, city: "Rockdale", state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com/mining-source",
        label: "Mining Source",
        retrievedAt: "2024-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2024-06-01",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Economics sub-group
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Economics", () => {
  it("renders Investment, Land, and Jobs when all economics fields are present", () => {
    const facility = makeFacility({
      investmentUsd: 3_500_000_000,
      landAcres: 500,
      jobs: { construction: 2500, permanent: 350 },
    });
    render(<CivicImpactSection facility={facility} />);

    // Investment formatted as compact USD
    expect(screen.getByText("$3.5B")).toBeInTheDocument();
    // Land
    expect(screen.getByText(/500 acres/)).toBeInTheDocument();
    // Jobs: both construction and permanent
    expect(
      screen.getByText(/2,500 construction · 350 permanent/)
    ).toBeInTheDocument();
  });

  it("omits the Jobs row when neither construction nor permanent is set", () => {
    const facility = makeFacility({
      investmentUsd: 1_000_000_000,
      jobs: {},
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.queryByText(/construction/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/permanent/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Energy & water sub-group
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Energy & water", () => {
  it("renders energy source label and cooling type label", () => {
    const facility = makeFacility({
      energy: { source: "solar" },
      water: { coolingType: "closed_loop" },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.getByText("Solar")).toBeInTheDocument();
    expect(screen.getByText("Closed-loop")).toBeInTheDocument();
  });

  it("renders both Energy source and Utility rows when source and utility are both set", () => {
    const facility = makeFacility({
      energy: { source: "grid", utility: "AES Indiana" },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.getByText("Grid")).toBeInTheDocument();
    expect(screen.getByText("AES Indiana")).toBeInTheDocument();
  });

  it("renders the Utility row when utility is set without a source", () => {
    const facility = makeFacility({
      energy: { utility: "AES Indiana" },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.getByText("Utility")).toBeInTheDocument();
    expect(screen.getByText("AES Indiana")).toBeInTheDocument();
    expect(screen.queryByText("Energy source")).not.toBeInTheDocument();
  });

  it("renders only the Energy source row when source is set without a utility", () => {
    const facility = makeFacility({
      energy: { source: "solar" },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.getByText("Energy source")).toBeInTheDocument();
    expect(screen.getByText("Solar")).toBeInTheDocument();
    expect(screen.queryByText("Utility")).not.toBeInTheDocument();
  });

  it("renders energy notes and water notes as muted paragraphs", () => {
    const facility = makeFacility({
      energy: { notes: "PPA signed for 100% renewable." },
      water: { notes: "Closed-loop, no evaporative loss." },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(
      screen.getByText("PPA signed for 100% renewable.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Closed-loop, no evaporative loss.")
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Air permit (emissions) sub-group
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Air permit (emissions)", () => {
  it("renders every pollutant with its value and unit", () => {
    const facility = makeFacility({
      emissions: {
        permittedTpy: {
          nox: 245.5,
          co: 120,
          pm25: 8,
          pm10: 10,
          so2: 5,
          voc: 15,
          co2e: 250_000,
        },
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("NOx")).toBeInTheDocument();
    expect(screen.getByText("245.5 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("CO")).toBeInTheDocument();
    expect(screen.getByText("120 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("PM2.5")).toBeInTheDocument();
    expect(screen.getByText("8 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("PM10")).toBeInTheDocument();
    expect(screen.getByText("10 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("SO2")).toBeInTheDocument();
    expect(screen.getByText("5 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("VOC")).toBeInTheDocument();
    expect(screen.getByText("15 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("CO2e")).toBeInTheDocument();
    expect(screen.getByText("250,000 tons/yr")).toBeInTheDocument();
  });

  // Regression: a `0` permitted limit is a real regulatory fact (a pollutant
  // a unit is prohibited from emitting) and must render, never be hidden by
  // a truthy check. This is the single most likely bug in this unit.
  it("renders a 0 permitted limit as '0 tons/yr' rather than hiding it, alongside a non-zero sibling", () => {
    // A non-zero sibling (co: 12) is included deliberately: it keeps
    // `hasContent` true under a truthy-check regression, so a failure here
    // can only mean the NOx row itself was hidden — not that the whole
    // group unmounted for an unrelated reason.
    const facility = makeFacility({
      emissions: { permittedTpy: { nox: 0, co: 12 } },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("NOx")).toBeInTheDocument();
    expect(screen.getByText("0 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("CO")).toBeInTheDocument();
    expect(screen.getByText("12 tons/yr")).toBeInTheDocument();
  });

  it("renders the mandatory 'regulatory ceiling, not measured emissions' line whenever the group renders", () => {
    const facility = makeFacility({
      emissions: { permittedTpy: { nox: 10 } },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(
      screen.getByText(/regulatory ceiling, not measured emissions/i)
    ).toBeInTheDocument();
  });

  it("renders permit number, permit type label, issuing agency, and issued date", () => {
    const facility = makeFacility({
      emissions: {
        permitNumber: "P0123456",
        permitType: "title_v",
        issuingAgency: "Texas Commission on Environmental Quality",
        issuedDate: "2023-05-01",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("Permit")).toBeInTheDocument();
    expect(screen.getByText("P0123456")).toBeInTheDocument();
    expect(screen.getByText("Permit type")).toBeInTheDocument();
    expect(screen.getByText("Title V")).toBeInTheDocument();
    expect(screen.getByText("Agency")).toBeInTheDocument();
    expect(
      screen.getByText("Texas Commission on Environmental Quality")
    ).toBeInTheDocument();
    expect(screen.getByText("Issued")).toBeInTheDocument();
    expect(screen.getByText("2023-05-01")).toBeInTheDocument();
  });

  it("renders emissions notes as a muted paragraph, with no pollutants or permit metadata", () => {
    // Deliberately no permittedTpy/permitNumber/permitType/issuingAgency/
    // issuedDate — isolates that the `!!emissions.notes` disjunct in
    // `hasContent` is what renders the group, not an incidental pollutant.
    const facility = makeFacility({
      emissions: { notes: "Permit under renewal as of 2026." },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(
      screen.getByText("Permit under renewal as of 2026.")
    ).toBeInTheDocument();
  });

  it("omits the Air permit group when emissions is absent", () => {
    const facility = makeFacility({ investmentUsd: 1_000_000 });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.queryByText("Air permit")).not.toBeInTheDocument();
  });

  it("renders nothing for emissions: {} (no pollutants, no permit metadata, no notes)", () => {
    const facility = makeFacility({ emissions: {} });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.queryByText("Air permit")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/regulatory ceiling, not measured emissions/i)
    ).not.toBeInTheDocument();
  });

  it("renders a source link for the cited permit source", () => {
    const facility = makeFacility({
      emissions: {
        permittedTpy: { nox: 10 },
        sourceIndex: 0,
      },
    });
    render(<CivicImpactSection facility={facility} />);

    const link = screen.getByRole("link", {
      name: /Subsidy Source \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute("href", "https://example.com/subsidy-source");
  });

  it("renders 'Per unit' for basis alongside the tonnages", () => {
    const facility = makeFacility({
      emissions: {
        permittedTpy: { nox: 5.6 },
        basis: "per_unit",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("Limits apply to")).toBeInTheDocument();
    expect(screen.getByText("Per unit")).toBeInTheDocument();
  });

  it("renders 'Facility-wide' for basis alongside the tonnages", () => {
    const facility = makeFacility({
      emissions: {
        permittedTpy: { nox: 1142.8 },
        basis: "facility_wide",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("Limits apply to")).toBeInTheDocument();
    expect(screen.getByText("Facility-wide")).toBeInTheDocument();
  });

  it("renders unitsCovered and averagingPeriod when present", () => {
    const facility = makeFacility({
      emissions: {
        permittedTpy: { nox: 1142.8 },
        basis: "facility_wide",
        unitsCovered: "Units 1-4 (combustion turbines)",
        averagingPeriod: "rolling_12_month",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("Units covered")).toBeInTheDocument();
    expect(
      screen.getByText("Units 1-4 (combustion turbines)")
    ).toBeInTheDocument();
    expect(screen.getByText("Averaging period")).toBeInTheDocument();
    expect(screen.getByText("12-month rolling")).toBeInTheDocument();
  });

  // Fixture shaped like the real xAI/MZX permit from the pilot: every
  // tonnage is per-turbine, the permit names the covered equipment, and GHG
  // is capped only as a rate — there is no facility-wide CO2e tonnage at
  // all. This must render the pollutants it has and must NOT render a CO2e
  // row, and must not crash despite `co2e` being absent.
  it("renders an xAI-shaped per-unit permit without a CO2e row and without crashing", () => {
    const facility = makeFacility({
      emissions: {
        permittedTpy: { nox: 15.47, formaldehyde: 0.9 },
        basis: "per_unit",
        unitsCovered: "41 combustion turbines",
        notes: "GHG capped only as a rate (<=120 lb/MMBtu), not an annual tonnage.",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("NOx")).toBeInTheDocument();
    expect(screen.getByText("Formaldehyde")).toBeInTheDocument();
    expect(screen.getByText("Per unit")).toBeInTheDocument();
    expect(screen.getByText("41 combustion turbines")).toBeInTheDocument();
    expect(screen.queryByText("CO2e")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Air permit — per-equipment-group limits (emissions.unitGroups)
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Air permit unit groups", () => {
  // Item-1 trap: a record with ONLY unitGroups (no top-level permittedTpy,
  // no basis, no permit metadata) must still render the panel. Before the
  // `unitGroups.length > 0` disjunct was added to `hasContent`, this shape
  // computed `hasContent === false` and the whole panel silently rendered
  // nothing — this is the xAI/MZX MS shape from the pilot.
  it("renders the panel and both groups' values for a groups-only record (no top-level permittedTpy)", () => {
    const facility = makeFacility({
      emissions: {
        unitGroups: [
          {
            label: "Solar Titan 350 turbines",
            unitCount: 6,
            basis: "per_unit",
            permittedTpy: { nox: 14.98 },
          },
          {
            label: "GE LM2500 turbines",
            unitCount: 4,
            basis: "per_unit",
            permittedTpy: { nox: 13.44 },
          },
        ],
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("Air permit")).toBeInTheDocument();
    expect(
      screen.getByText(/regulatory ceiling, not measured emissions/i)
    ).toBeInTheDocument();
    expect(screen.getByText("Solar Titan 350 turbines")).toBeInTheDocument();
    expect(screen.getByText("14.98 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("GE LM2500 turbines")).toBeInTheDocument();
    expect(screen.getByText("13.44 tons/yr")).toBeInTheDocument();
  });

  it("renders unitCount when present and omits the Units row when absent", () => {
    const facility = makeFacility({
      emissions: {
        unitGroups: [
          {
            label: "Turbines with a stated count",
            unitCount: 6,
            basis: "group_wide",
            permittedTpy: { nox: 90 },
          },
          {
            label: "Turbines without a stated count",
            basis: "group_wide",
            permittedTpy: { co: 30 },
          },
        ],
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("6 units")).toBeInTheDocument();
    // Only one group states a unitCount, so exactly one "Units" row exists.
    expect(screen.getAllByText("Units")).toHaveLength(1);
  });

  // A 0 tpy value in a group is a real regulatory fact (a pollutant a unit
  // is prohibited from emitting) and must render, never be hidden by a
  // truthy check — same rule as the facility-wide pollutant table above.
  it("renders a 0 tpy value in a group rather than hiding it", () => {
    const facility = makeFacility({
      emissions: {
        unitGroups: [
          {
            label: "Zero-NOx group",
            basis: "group_wide",
            permittedTpy: { nox: 0, co: 5 },
          },
        ],
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("NOx")).toBeInTheDocument();
    expect(screen.getByText("0 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("CO")).toBeInTheDocument();
    expect(screen.getByText("5 tons/yr")).toBeInTheDocument();
  });

  it("labels a per_unit group 'Per unit' and a group_wide group 'Group total'", () => {
    const facility = makeFacility({
      emissions: {
        unitGroups: [
          {
            label: "Per-unit group",
            basis: "per_unit",
            permittedTpy: { nox: 1 },
          },
          {
            label: "Group-wide group",
            basis: "group_wide",
            permittedTpy: { co: 2 },
          },
        ],
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("Per unit")).toBeInTheDocument();
    expect(screen.getByText("Group total")).toBeInTheDocument();
  });

  // Regression: the pre-existing Homer City shape (facility_wide basis +
  // top-level permittedTpy, no unitGroups) must render exactly as before,
  // with no group markup (no <h4> sub-headings, no "Units" rows).
  it("renders the pre-existing facility_wide shape unchanged when unitGroups is absent", () => {
    const facility = makeFacility({
      emissions: {
        permittedTpy: { nox: 245.5, co2e: 250_000 },
        basis: "facility_wide",
        permitNumber: "PA-0012345",
        permitType: "title_v",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("NOx")).toBeInTheDocument();
    expect(screen.getByText("245.5 tons/yr")).toBeInTheDocument();
    expect(screen.getByText("Facility-wide")).toBeInTheDocument();
    expect(screen.getByText("PA-0012345")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 4 })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Units")).not.toBeInTheDocument();
    expect(screen.queryByText("Group total")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Public subsidies sub-group
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Public subsidies", () => {
  it("renders subsidy with amount and resolves the source link", () => {
    const facility = makeFacility({
      subsidies: [
        {
          program: "Tax Abatement",
          amountUsd: 450_000_000,
          jurisdiction: "Illinois",
          year: "2023",
          sourceIndex: 0,
        },
      ],
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("Tax Abatement")).toBeInTheDocument();
    expect(screen.getByText("$450M")).toBeInTheDocument();
    expect(screen.getByText(/Illinois · 2023/)).toBeInTheDocument();

    const link = screen.getByRole("link", {
      name: /Subsidy Source \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute("href", "https://example.com/subsidy-source");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("uses 'Subsidy' as fallback label when program is absent", () => {
    const facility = makeFacility({
      subsidies: [{ amountUsd: 10_000_000 }],
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.getByText("Subsidy")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Community sentiment sub-group
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Community sentiment", () => {
  it("renders community status as a labeled badge (not color-only)", () => {
    const facility = makeFacility({
      community: { status: "contested", notes: "Noise complaints ongoing." },
    });
    render(<CivicImpactSection facility={facility} />);

    // Text label inside the badge
    expect(screen.getByText("Contested")).toBeInTheDocument();
    // Notes
    expect(screen.getByText("Noise complaints ongoing.")).toBeInTheDocument();
  });

  it("renders a source link for community when sourceIndex is set", () => {
    const facility = makeFacility({
      community: { status: "supported", sourceIndex: 1 },
    });
    render(<CivicImpactSection facility={facility} />);

    const link = screen.getByRole("link", {
      name: /Community Report \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://example.com/community-source"
    );
  });
});

// ---------------------------------------------------------------------------
// Mining sub-group (crypto_mining branch only)
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Mining", () => {
  it("renders hash rate, hardware type, cooling type, and power arrangement", () => {
    const facility = makeMiningFacility({
      mining: {
        hashRateThPerS: 5_500,
        hardwareType: "asic",
        coolingType: "immersion",
        powerArrangement: "stranded_gas",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText(/5,500 TH\/s/)).toBeInTheDocument();
    expect(screen.getByText("ASIC")).toBeInTheDocument();
    expect(screen.getByText("Immersion")).toBeInTheDocument();
    expect(screen.getByText(/stranded gas/i)).toBeInTheDocument();
  });

  it("omits the Mining group when mining is absent on a crypto_mining facility", () => {
    const facility = makeMiningFacility();
    render(<CivicImpactSection facility={facility} />);
    expect(screen.queryByText("Mining")).not.toBeInTheDocument();
  });

  it("does not render the Mining group for data_center facilities", () => {
    const facility = makeFacility({ investmentUsd: 1_000_000 });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.queryByText("Mining")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Environmental sub-group (both branches, different shapes)
// ---------------------------------------------------------------------------
describe("CivicImpactSection — Environmental (data_center)", () => {
  it("renders PUE with confidence qualifier, WUE, grid carbon intensity, and renewable percent", () => {
    const facility = makeFacility({
      environmental: {
        pue: 1.2,
        pueConfidence: "confirmed",
        wue: 0.4,
        gridCarbonIntensityGCo2PerKwh: 350,
        renewablePercent: 60,
        waterStress: "medium",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText(/1\.2 PUE \(confirmed\)/)).toBeInTheDocument();
    expect(screen.getByText("0.4")).toBeInTheDocument();
    expect(screen.getByText(/350 gCO2\/kWh/)).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
  });

  it("renders waterStress even when it is the schema default 'unknown'", () => {
    const facility = makeFacility({
      environmental: { pue: 1.5, waterStress: "unknown" },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("omits the Environmental group when environmental is absent", () => {
    const facility = makeFacility({ investmentUsd: 1_000_000 });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.queryByText("Environmental")).not.toBeInTheDocument();
  });
});

describe("CivicImpactSection — Environmental (crypto_mining)", () => {
  it("renders carbon proxy and carbon basis", () => {
    const facility = makeMiningFacility({
      environmental: {
        carbonIntensityProxy: 420,
        carbonIntensityBasis: "grid_average",
      },
    });
    render(<CivicImpactSection facility={facility} />);

    expect(screen.getByText("420")).toBeInTheDocument();
    expect(screen.getByText("Grid average")).toBeInTheDocument();
  });

  it("omits the Environmental group when environmental is absent", () => {
    const facility = makeMiningFacility({
      mining: { hashRateThPerS: 1_000 },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(screen.queryByText("Environmental")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// hasCivicImpact predicate + null render
// ---------------------------------------------------------------------------
describe("hasCivicImpact", () => {
  it("returns false when no civic fields are present", () => {
    const facility = makeFacility();
    expect(hasCivicImpact(facility)).toBe(false);
  });

  it("returns true when investmentUsd is set", () => {
    const facility = makeFacility({ investmentUsd: 1_000_000 });
    expect(hasCivicImpact(facility)).toBe(true);
  });

  it("returns false for subsidies:[] (empty array)", () => {
    const facility = makeFacility({ subsidies: [] });
    expect(hasCivicImpact(facility)).toBe(false);
  });

  it("returns true for subsidies with at least one entry", () => {
    const facility = makeFacility({ subsidies: [{ program: "Grant" }] });
    expect(hasCivicImpact(facility)).toBe(true);
  });

  it("returns true when only mining is populated (regression: mining was previously ignored)", () => {
    const facility = makeMiningFacility({
      mining: { hashRateThPerS: 1_000 },
    });
    expect(hasCivicImpact(facility)).toBe(true);
  });

  it("returns true when only environmental is populated (regression: environmental was previously ignored)", () => {
    const facility = makeFacility({
      environmental: { pue: 1.3, waterStress: "unknown" },
    });
    expect(hasCivicImpact(facility)).toBe(true);
  });

  it("returns true when only emissions is populated", () => {
    const facility = makeFacility({
      emissions: { permittedTpy: { nox: 10 } },
    });
    expect(hasCivicImpact(facility)).toBe(true);
  });

  it("returns false for a crypto_mining facility with no mining, environmental, or other civic fields", () => {
    const facility = makeMiningFacility();
    expect(hasCivicImpact(facility)).toBe(false);
  });
});

describe("CivicImpactSection — renders nothing when no civic fields present", () => {
  it("renders nothing when hasCivicImpact is false", () => {
    const facility = makeFacility();
    const { container } = render(<CivicImpactSection facility={facility} />);
    expect(container).toBeEmptyDOMElement();
  });
});
