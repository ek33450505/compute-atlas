import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts (same
// pattern as app/stats/page.test.tsx).
const {
  mockGetStats,
  mockGetGenerationBuildoutStats,
  mockGetWaterStressExposure,
  mockGetCommunityReceptionCounts,
  mockGetFrictionTotal,
  mockGetDatasetEdition,
} = vi.hoisted(() => ({
  mockGetStats: vi.fn(),
  mockGetGenerationBuildoutStats: vi.fn(),
  mockGetWaterStressExposure: vi.fn(),
  mockGetCommunityReceptionCounts: vi.fn(),
  // Mirrors the real lib/data.ts implementation (a pure sum) rather than
  // importing the actual module, which would pull in its DB setup.
  mockGetFrictionTotal: vi.fn(
    (counts: { contested?: number; opposed?: number; litigation?: number }) =>
      (counts.contested ?? 0) + (counts.opposed ?? 0) + (counts.litigation ?? 0)
  ),
  mockGetDatasetEdition: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStats: mockGetStats,
  getGenerationBuildoutStats: mockGetGenerationBuildoutStats,
  getWaterStressExposure: mockGetWaterStressExposure,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
  getFrictionTotal: mockGetFrictionTotal,
}));

vi.mock("@/lib/dataset-edition", () => ({
  getDatasetEdition: mockGetDatasetEdition,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/support/page.test.tsx).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  ),
}));

import AboutPage from "./page";

function mockNonZero() {
  mockGetStats.mockReset().mockResolvedValue({
    count: 1659,
    states: 45,
    stateCodes: [
      "AL", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI",
      "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
      "MI", "MN", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
      "NC", "ND", "OH", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
      "UT", "VA", "WA", "WI", "WY"
    ],
    includesDc: true,
    operationalMw: 50000,
    plannedMw: 90000,
    underConstructionMw: 12000,
  });
  mockGetGenerationBuildoutStats.mockReset().mockResolvedValue({
    fossilPlannedMw: 84210,
    nonFossilPlannedMw: 31337,
    fossilPlants: 80,
    nonFossilPlants: 47,
    gas: { total: 80, operational: 15, proposed: 31, permitted: 18, underConstruction: 16 },
  });
  mockGetWaterStressExposure.mockReset().mockResolvedValue({
    rated: 8888,
    highOrExtreme: 3333,
    extreme: 120,
  });
  mockGetCommunityReceptionCounts.mockReset().mockResolvedValue({
    supported: 40,
    mixed: 20,
    contested: 411,
    opposed: 222,
    litigation: 77,
    unknown: 10,
  });
  mockGetDatasetEdition.mockReset().mockReturnValue({
    version: "1.30.0",
    asOf: "2026-09-01T16:58:23.496Z",
    recordCount: 1659,
    schemaVersion: 1,
  });
}

describe("AboutPage — § The stance", () => {
  it('renders the "Non-partisan, not neutral." heading', async () => {
    mockNonZero();
    const page = await AboutPage();
    render(page);

    expect(
      screen.getByRole("heading", { level: 3, name: "Non-partisan, not neutral." })
    ).toBeInTheDocument();
  });

  it("still renders the per-facility neutrality promise (P1), a durable product commitment", async () => {
    mockNonZero();
    const page = await AboutPage();
    render(page);

    expect(
      screen.getByText(
        /Compute Atlas takes no editorial position on whether any particular facility should be built, and it is not affiliated with any company, advocacy group, or government agency\./
      )
    ).toBeInTheDocument();
  });

  it("prints all five interpolated figures from the mocked helpers, not hardcoded literals", async () => {
    mockNonZero();
    const page = await AboutPage();
    const { container } = render(page);
    const text = container.textContent ?? "";

    // Distinctive synthetic values (not the real dataset's current figures)
    // so a hardcoded literal in the page would fail this assertion instead
    // of coincidentally satisfying it.
    // formatPower(84210) === "84.2 GW", formatPower(31337) === "31.3 GW"
    expect(text).toContain("84.2 GW");
    expect(text).toContain("31.3 GW");
    // waterStress.highOrExtreme / waterStress.rated, each toLocaleString("en-US")
    expect(text).toContain("3,333");
    expect(text).toContain("8,888");
    // frictionTotal = contested + opposed + litigation = 411 + 222 + 77 = 710
    expect(text).toContain("710");
    // community.litigation
    expect(text).toMatch(/77 of them/);
  });

  it("renders the three receipts links with meaningful accessible names and the right hrefs", async () => {
    mockNonZero();
    const page = await AboutPage();
    render(page);

    expect(
      screen.getByRole("link", { name: "the generation being built specifically to serve compute" })
    ).toHaveAttribute("href", "/power");
    expect(
      screen.getByRole("link", { name: "baseline water stress high or extremely high" })
    ).toHaveAttribute("href", "/learn/data-center-water-use");
    expect(
      screen.getByRole("link", { name: "documented local opposition" })
    ).toHaveAttribute("href", "/opposition");
  });

  it("renders the fence paragraph (P4) stating this is not an argument against AI or data centers", async () => {
    mockNonZero();
    const page = await AboutPage();
    render(page);

    expect(
      screen.getByText(/None of that is an argument against AI, or against computing at scale\./)
    ).toBeInTheDocument();
  });

  it("zero-state: omits the water-stress and opposition clauses rather than printing '0 of 0' as a finding, with no NaN or Infinity anywhere on the page", async () => {
    mockGetStats.mockReset().mockResolvedValue({
      count: 0,
      states: 0,
      stateCodes: [],
      includesDc: false,
      operationalMw: 0,
      plannedMw: 0,
      underConstructionMw: 0,
    });
    mockGetGenerationBuildoutStats.mockReset().mockResolvedValue({
      fossilPlannedMw: 0,
      nonFossilPlannedMw: 0,
      fossilPlants: 0,
      nonFossilPlants: 0,
      gas: { total: 0, operational: 0, proposed: 0, permitted: 0, underConstruction: 0 },
    });
    mockGetWaterStressExposure.mockReset().mockResolvedValue({
      rated: 0,
      highOrExtreme: 0,
      extreme: 0,
    });
    mockGetCommunityReceptionCounts.mockReset().mockResolvedValue({
      supported: 0,
      mixed: 0,
      contested: 0,
      opposed: 0,
      litigation: 0,
      unknown: 0,
    });
    mockGetDatasetEdition.mockReset().mockReturnValue({
      version: "0.0.0",
      asOf: "2026-09-01T16:58:23.496Z",
      recordCount: 0,
      schemaVersion: 1,
    });

    const page = await AboutPage();
    const { container } = render(page);
    const text = container.textContent ?? "";

    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    // The ratio-style clauses ("N of M sites...", "N sites have drawn...")
    // must be omitted entirely on a zero dataset, not printed as "0 of 0".
    expect(screen.queryByText(/sites with basin data on file/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sites have drawn/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "baseline water stress high or extremely high" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "documented local opposition" })
    ).not.toBeInTheDocument();
    // The sentence still reads as valid English even with both ratio clauses
    // gone — "Each figure" now refers only to the always-present buildout
    // figures.
    expect(
      screen.getByText(/still open\.\s*Each figure is a count of sourced records, not an estimate\./)
    ).toBeInTheDocument();
    // The gas-vs-non-fossil link and its always-present figures still render.
    expect(
      screen.getByRole("link", { name: "the generation being built specifically to serve compute" })
    ).toHaveAttribute("href", "/power");
  });
});
