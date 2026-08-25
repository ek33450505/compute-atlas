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
