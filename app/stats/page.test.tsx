import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const {
  mockGetStats,
  mockGetStatusCounts,
  mockGetCivicCoverage,
  mockGetAiClassificationCounts,
  mockGetConfidenceCounts,
  mockGetTopStates,
  mockGetTopOperators,
  mockGetWaterUsage,
  mockGetCoolingTypeCounts,
  mockGetFacilityTypeCounts,
  mockGetCommunityReceptionCounts,
  mockGetEnergySourceCounts,
  mockGetAllFacilities,
  mockGetDatasetEdition,
} = vi.hoisted(() => ({
  mockGetStats: vi.fn(),
  mockGetStatusCounts: vi.fn(),
  mockGetCivicCoverage: vi.fn(),
  mockGetAiClassificationCounts: vi.fn(),
  mockGetConfidenceCounts: vi.fn(),
  mockGetTopStates: vi.fn(),
  mockGetTopOperators: vi.fn(),
  mockGetWaterUsage: vi.fn(),
  mockGetCoolingTypeCounts: vi.fn(),
  mockGetFacilityTypeCounts: vi.fn(),
  mockGetCommunityReceptionCounts: vi.fn(),
  mockGetEnergySourceCounts: vi.fn(),
  mockGetAllFacilities: vi.fn(),
  mockGetDatasetEdition: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStats: mockGetStats,
  getStatusCounts: mockGetStatusCounts,
  getCivicCoverage: mockGetCivicCoverage,
  getAiClassificationCounts: mockGetAiClassificationCounts,
  getConfidenceCounts: mockGetConfidenceCounts,
  getTopStates: mockGetTopStates,
  getTopOperators: mockGetTopOperators,
  getWaterUsage: mockGetWaterUsage,
  getCoolingTypeCounts: mockGetCoolingTypeCounts,
  getFacilityTypeCounts: mockGetFacilityTypeCounts,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
  getEnergySourceCounts: mockGetEnergySourceCounts,
  getAllFacilities: mockGetAllFacilities,
}));

vi.mock("@/lib/dataset-edition", () => ({
  getDatasetEdition: mockGetDatasetEdition,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency in
// jsdom (Breadcrumb renders Link internally).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import StatsPage from "./page";

const ALL_FACILITIES = [
  { facilityType: "data_center", capacityMw: { operational: 120 } },
  { facilityType: "data_center", capacityMw: {} },
  { facilityType: "crypto_mining", capacityMw: { planned: 40 } },
  { facilityType: "power_generation", capacityMw: { operational: 300 } },
  { facilityType: "data_center", capacityMw: {} },
] as never; // loosely-typed fixture — only facilityType/capacityMw are read by the page

beforeEach(() => {
  mockGetStats.mockReset().mockResolvedValue({
    count: 5,
    states: 3,
    operationalMw: 5000,
    plannedMw: 3000,
    underConstructionMw: 1200,
  });
  mockGetStatusCounts.mockReset().mockResolvedValue({
    operational: 2,
    under_construction: 1,
    permitted: 1,
    proposed: 1,
    cancelled: 0,
  });
  mockGetCivicCoverage.mockReset().mockResolvedValue({
    energy: 3,
    water: 2,
    subsidies: 1,
    investment: 2,
    jobs: 2,
    community: 4,
  });
  mockGetAiClassificationCounts.mockReset().mockResolvedValue({
    confirmed: 1,
    likely: 1,
    mixed_use: 0,
  });
  mockGetConfidenceCounts.mockReset().mockResolvedValue({
    confirmed: 3,
    reported: 1,
    rumored: 1,
  });
  mockGetTopStates.mockReset().mockResolvedValue([{ state: "TX", count: 2 }]);
  mockGetTopOperators.mockReset().mockResolvedValue([{ operator: "Test Operator", count: 2 }]);
  mockGetWaterUsage.mockReset().mockResolvedValue({ reportingCount: 2, totalMgd: 5.5 });
  mockGetCoolingTypeCounts.mockReset().mockResolvedValue({
    evaporative: 1,
    air: 1,
    closed_loop: 1,
    hybrid: 0,
    unknown: 2,
  });
  mockGetFacilityTypeCounts.mockReset().mockResolvedValue({
    data_center: 3,
    crypto_mining: 1,
    power_generation: 1,
  });
  mockGetCommunityReceptionCounts.mockReset().mockResolvedValue({
    supported: 1,
    mixed: 1,
    contested: 0,
    opposed: 0,
    litigation: 0,
    unknown: 3,
  });
  mockGetEnergySourceCounts.mockReset().mockResolvedValue({
    grid: 2,
    on_site_gas: 1,
    nuclear: 0,
    solar: 1,
    wind: 0,
    hydro: 0,
    mixed: 0,
    other: 1,
  });
  mockGetAllFacilities.mockReset().mockResolvedValue(ALL_FACILITIES);
  mockGetDatasetEdition.mockReset().mockReturnValue({
    version: "1.30.0",
    asOf: "2026-09-01T16:58:23.496Z",
    recordCount: 1309,
    schemaVersion: 1,
  });
});

describe("StatsPage — § Data coverage dimension count", () => {
  // Regression coverage for the same latent-drift bug family fixed in PR #170
  // (/explore's "five ways", /status's "five lifecycle stages"): the prose
  // must derive its dimension count from the same array that renders the
  // dimension rows, not from a hand-typed numeral that can silently drift.
  it("states the same dimension count in prose as the number of rendered coverage rows", async () => {
    const page = await StatsPage();
    render(page);

    const heading = screen.getByRole("heading", { level: 2, name: "Civic-data coverage" });
    const section = heading.closest("section");
    if (!section) throw new Error("no section wrapping the Civic-data coverage heading");

    const dimensionLabels = ["Energy", "Water", "Subsidies", "Investment", "Jobs", "Community"];
    for (const label of dimensionLabels) {
      expect(within(section).getByText(label)).toBeInTheDocument();
    }

    const prose = within(section).getByText(/the same logic applies across all/);
    expect(prose.textContent).toContain(`all ${dimensionLabels.length} dimensions.`);
  });
});

describe("StatsPage — disclosedCapacityCount excludes cancelled facilities", () => {
  it("excludes a cancelled facility from the disclosed capacity count even if it discloses capacity", async () => {
    mockGetAllFacilities.mockReset().mockResolvedValue([
      { facilityType: "data_center", capacityMw: { operational: 120 }, status: "operational" },
      { facilityType: "data_center", capacityMw: { operational: 100 }, status: "cancelled" },
      { facilityType: "crypto_mining", capacityMw: { planned: 40 }, status: "proposed" },
    ] as never);
    mockGetStats.mockReset().mockResolvedValue({
      count: 3,
      states: 1,
      operationalMw: 120,
      plannedMw: 40,
      underConstructionMw: 0,
    });

    const page = await StatsPage();
    render(page);

    // The denominator is total (3), but the numerator should be 2 — only
    // non-cancelled facilities with disclosed capacity (operational 120 and
    // planned 40), not the cancelled facility even though it discloses 100 MW.
    expect(
      screen.getByText(/Capacity is disclosed for 2 of the 3 tracked sites/)
    ).toBeInTheDocument();
  });

  it("includes non-cancelled facilities with disclosed capacity in the count", async () => {
    mockGetAllFacilities.mockReset().mockResolvedValue([
      { facilityType: "data_center", capacityMw: { operational: 120 }, status: "operational" },
      { facilityType: "data_center", capacityMw: {}, status: "operational" },
      { facilityType: "crypto_mining", capacityMw: { planned: 40 }, status: "proposed" },
    ] as never);
    mockGetStats.mockReset().mockResolvedValue({
      count: 3,
      states: 1,
      operationalMw: 120,
      plannedMw: 40,
      underConstructionMw: 0,
    });

    const page = await StatsPage();
    render(page);

    // Should show 2 of 3: the operational facility with capacity and the
    // proposed facility with capacity, but not the operational facility
    // without disclosed capacity.
    expect(
      screen.getByText(/Capacity is disclosed for 2 of the 3 tracked sites/)
    ).toBeInTheDocument();
  });
});

describe("StatsPage — dataset edition", () => {
  it("surfaces the real edition version, asOf date, and record count from getDatasetEdition, not a hardcoded year", async () => {
    const page = await StatsPage();
    render(page);

    // Two elements legitimately carry "Edition v1.30.0" — the masthead
    // eyebrow and the summary line — so scope the eyebrow check to the
    // header's uppercase eyebrow text specifically, distinct from the
    // summary line asserted below. Regression coverage for the page
    // previously hardcoding a literal "Edition 2026" in the eyebrow.
    expect(
      screen.getByText(/Coverage & completeness · Edition v1\.30\.0/)
    ).toBeInTheDocument();

    const summary = screen.getByText(/snapshot as of September 1, 2026/);
    expect(summary.textContent).toContain("Edition v1.30.0");
    expect(summary.textContent).toContain("1,309 records at export");

    expect(screen.getByRole("link", { name: "how to cite" })).toHaveAttribute(
      "href",
      "/api#citation-heading"
    );
  });

  it("reflects a different edition when the dataset is republished, rather than a frozen value", async () => {
    mockGetDatasetEdition.mockReset().mockReturnValue({
      version: "2.0.0",
      asOf: "2027-01-15T00:00:00.000Z",
      recordCount: 2000,
      schemaVersion: 1,
    });

    const page = await StatsPage();
    render(page);

    expect(
      screen.getByText(/Coverage & completeness · Edition v2\.0\.0/)
    ).toBeInTheDocument();
    expect(screen.getByText(/snapshot as of January 15, 2027/)).toBeInTheDocument();
  });
});
