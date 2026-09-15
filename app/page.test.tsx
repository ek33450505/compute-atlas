import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock calls are hoisted above imports, so the shared mock fns go through
// vi.hoisted() (same pattern as app/power/page.test.tsx).
const {
  mockGetStats,
  mockGetNotableFacilities,
  mockGetRecentActivity,
  mockGetAllFacilities,
  mockGetCommunityReceptionCounts,
  mockGetAiClassificationCounts,
  mockGetFacilityTypeCounts,
  mockGetNotableOppositionCases,
  mockGetGenerationBuildoutStats,
  mockGetWaterStressExposure,
  mockGetFrictionTotal,
  mockGetCounties,
  mockGetQuarterlyPipelineSummary,
  mockGetDatasetEdition,
} = vi.hoisted(() => ({
  mockGetStats: vi.fn(),
  mockGetNotableFacilities: vi.fn(),
  mockGetRecentActivity: vi.fn(),
  mockGetAllFacilities: vi.fn(),
  mockGetCommunityReceptionCounts: vi.fn(),
  mockGetAiClassificationCounts: vi.fn(),
  mockGetFacilityTypeCounts: vi.fn(),
  mockGetNotableOppositionCases: vi.fn(),
  mockGetGenerationBuildoutStats: vi.fn(),
  mockGetWaterStressExposure: vi.fn(),
  mockGetFrictionTotal: vi.fn(),
  mockGetCounties: vi.fn(),
  mockGetQuarterlyPipelineSummary: vi.fn(),
  mockGetDatasetEdition: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStats: mockGetStats,
  getNotableFacilities: mockGetNotableFacilities,
  getRecentActivity: mockGetRecentActivity,
  getAllFacilities: mockGetAllFacilities,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
  getAiClassificationCounts: mockGetAiClassificationCounts,
  getFacilityTypeCounts: mockGetFacilityTypeCounts,
  getNotableOppositionCases: mockGetNotableOppositionCases,
  getGenerationBuildoutStats: mockGetGenerationBuildoutStats,
  getWaterStressExposure: mockGetWaterStressExposure,
  getFrictionTotal: mockGetFrictionTotal,
  getCounties: mockGetCounties,
  getQuarterlyPipelineSummary: mockGetQuarterlyPipelineSummary,
}));

// Pinned so the provenance line's date is deterministic — the real helper
// reads data/facilities.meta.json, which every data wave moves.
vi.mock("@/lib/dataset-edition", () => ({
  getDatasetEdition: mockGetDatasetEdition,
}));

// MapLibre needs `window` at module scope and is pure decoration here.
vi.mock("@/components/home/hero-globe-dynamic", () => ({
  HeroGlobe: () => <div aria-hidden="true" />,
}));

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

import HomePage from "./page";

const STATE_CODES = ["CA", "TX", "VA", "DC"];

/** Three facilities carrying 7 sources between them. */
const FACILITIES = [
  {
    id: "a",
    name: "Alpha",
    operator: "Acme",
    lastUpdated: "2026-09-01",
    energy: { utility: "Dominion" },
    sources: [{ url: "https://x/1" }, { url: "https://x/2" }, { url: "https://x/3" }],
  },
  {
    id: "b",
    name: "Bravo",
    operator: "Beta Corp",
    lastUpdated: "2026-09-02",
    sources: [{ url: "https://x/4" }, { url: "https://x/5" }],
  },
  {
    id: "c",
    name: "Charlie",
    operator: "Acme",
    lastUpdated: "2026-09-03",
    sources: [{ url: "https://x/6" }, { url: "https://x/7" }],
  },
];

beforeEach(() => {
  mockGetDatasetEdition.mockReturnValue({
    version: "1.30.0",
    asOf: "2026-09-15T00:00:00.000Z",
    recordCount: 1900,
    schemaVersion: 2,
  });
  mockGetStats.mockResolvedValue({
    count: 1929,
    states: 3,
    includesDc: true,
    stateCodes: STATE_CODES,
    operationalMw: 12000,
    plannedMw: 40000,
    underConstructionMw: 5000,
  });
  mockGetNotableFacilities.mockResolvedValue([]);
  mockGetRecentActivity.mockResolvedValue([]);
  mockGetAllFacilities.mockResolvedValue(FACILITIES);
  mockGetCommunityReceptionCounts.mockResolvedValue({
    litigation: 2,
    opposed: 3,
    contested: 4,
    supportive: 1,
    mixed: 0,
    neutral: 0,
  });
  mockGetFrictionTotal.mockReturnValue(9);
  mockGetAiClassificationCounts.mockResolvedValue({
    confirmed: 10,
    likely: 5,
    mixed_use: 2,
  });
  mockGetFacilityTypeCounts.mockResolvedValue({
    data_center: 50,
    crypto_mining: 7,
    power_generation: 3,
  });
  mockGetNotableOppositionCases.mockResolvedValue([]);
  mockGetGenerationBuildoutStats.mockResolvedValue({
    fossilPlannedMw: 69203,
    nonFossilPlannedMw: 19372,
    fossilPlants: 30,
    nonFossilPlants: 12,
    gas: {
      total: 80,
      operational: 15,
      proposed: 40,
      permitted: 15,
      underConstruction: 10,
    },
  });
  mockGetWaterStressExposure.mockResolvedValue({
    rated: 1651,
    highOrExtreme: 549,
  });
  mockGetCounties.mockResolvedValue([{ slug: "loudoun-va" }]);
  mockGetQuarterlyPipelineSummary.mockResolvedValue({
    newThisQuarter: 0,
    cancelledThisQuarter: 0,
    statusChangesThisQuarter: 0,
  });
});

/**
 * The provenance rule, located by its edition date. Scoped rather than
 * asserted against the whole page: OpenRecord legitimately renders a
 * "Recently updated" heading, so a page-wide "updated" assertion would be
 * testing the wrong element.
 */
function provenanceLine(): HTMLElement {
  return screen.getByText(/edition 15 Sep 2026/);
}

describe("HomePage hero", () => {
  it("renders the H1 verbatim", async () => {
    render(await HomePage());

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "America’s data centers, mapped and sourced.",
      })
    ).toBeInTheDocument();
  });

  it("renders a single subhead paragraph", async () => {
    render(await HomePage());

    expect(
      screen.getByText(
        /Public data on data centers is everywhere and nowhere/
      )
    ).toBeInTheDocument();
    // The second paragraph ("Track what's being built, where…") was cut to
    // reclaim the fold — it must not come back silently.
    expect(
      screen.queryByText(/how much of its cost to power, water, and neighbors/)
    ).not.toBeInTheDocument();
  });

  it("renders the provenance rule with the LIVE site and source counts", async () => {
    render(await HomePage());

    const line = provenanceLine();
    expect(line).toHaveTextContent("1,929 sites");
    expect(line).toHaveTextContent("3 states and DC");
    expect(line).toHaveTextContent("7 sources");
  });

  it("labels the snapshot date `edition`, never `updated`", async () => {
    render(await HomePage());

    const line = provenanceLine();
    expect(line.textContent).toContain("edition 15 Sep 2026");
    expect(line.textContent).not.toContain("updated");
    expect(line.textContent).not.toContain("Updated");
    // edition.recordCount (1,900) is a snapshot figure and must never appear
    // next to the live count on this line.
    expect(line.textContent).not.toContain("1,900");
  });

  it("omits the quarter segment when the quarter is empty", async () => {
    render(await HomePage());

    expect(provenanceLine().textContent).not.toContain("this quarter");
  });

  it("renders the quarter segment when the quarter moved", async () => {
    mockGetQuarterlyPipelineSummary.mockResolvedValue({
      newThisQuarter: 41,
      cancelledThisQuarter: 3,
      statusChangesThisQuarter: 12,
    });
    render(await HomePage());

    expect(provenanceLine().textContent).toContain(
      "+41 new this quarter, 3 cancelled"
    );
  });

  it("keeps the primary map CTA pointing at /map", async () => {
    render(await HomePage());

    expect(
      screen.getByRole("link", { name: /Explore the map/ })
    ).toHaveAttribute("href", "/map");
  });

  // The trailing → is decorative and aria-hidden, so it is excluded from the
  // accessible name — a screen reader must not announce "How this is sourced
  // right arrow". `toHaveAccessibleName` with a STRING compares the raw
  // computed name exactly (no whitespace normalization, unlike getByRole's
  // own name matcher), and the name computes to "How this is sourced" with no
  // trailing space: accname trims, so the space before the hidden span is
  // dropped. Measured, not assumed.
  it("offers the sourcing link as a named second action, without the arrow in its accessible name", async () => {
    render(await HomePage());

    const link = screen.getByRole("link", { name: "How this is sourced" });

    expect(link).toHaveAttribute("href", "/methodology");
    expect(link).toHaveAccessibleName("How this is sourced");
  });

  // A >=44px touch target on the quiet text link beside the h-11 map CTA.
  // jsdom computes no layout, so the class list is the only assertable
  // surface here; the rendered geometry is covered by the a11y e2e pass.
  it("gives the sourcing link a 44px-tall hit area", async () => {
    render(await HomePage());

    const link = screen.getByRole("link", { name: "How this is sourced" });

    expect(link).toHaveClass("inline-flex");
    expect(link).toHaveClass("min-h-11");
    expect(link).toHaveClass("items-center");
  });
});
