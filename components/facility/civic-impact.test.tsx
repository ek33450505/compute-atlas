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

  it("appends utility name to energy source when utility is set", () => {
    const facility = makeFacility({
      energy: { source: "grid", utility: "AES Indiana" },
    });
    render(<CivicImpactSection facility={facility} />);
    expect(
      screen.getByText("Grid · Utility: AES Indiana")
    ).toBeInTheDocument();
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
