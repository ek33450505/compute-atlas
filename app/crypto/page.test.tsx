import { vi, describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const { mockGetCryptoMiningStats, mockGetCryptoMiningFacilities } = vi.hoisted(() => ({
  mockGetCryptoMiningStats: vi.fn(),
  mockGetCryptoMiningFacilities: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getCryptoMiningStats: mockGetCryptoMiningStats,
  getCryptoMiningFacilities: mockGetCryptoMiningFacilities,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (Breadcrumb and the facility list render Link internally).
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

import CryptoPage from "./page";

function makeFacility(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-id",
    name: "Test Site",
    operator: "Test Operator",
    location: { state: "TX" },
    status: "operational",
    capacityMw: {},
    facilityType: "crypto_mining",
    confidence: "reported",
    source: { url: "https://example.com", kind: "news" },
    lastUpdated: "2026-01-01",
    ...overrides,
  };
}

// Regression coverage mirroring app/stats/page.test.tsx's
// "disclosedCapacityCount excludes cancelled facilities" suite: the
// disclosure sentence's numerator must match the exact population
// getCryptoMiningStats' operationalMw/plannedMw sum over (non-cancelled
// crypto_mining facilities), never the raw disclosed-capacity count across
// every status — otherwise "N of M disclose" would overstate what the MW
// tiles above it actually cover.
describe("CryptoPage — disclosure sentence matches the operationalMw/plannedMw population", () => {
  it("excludes a cancelled facility from the disclosed count even though it discloses capacity", async () => {
    mockGetCryptoMiningFacilities.mockReset().mockResolvedValue([
      makeFacility({
        id: "a",
        name: "Alpha",
        capacityMw: { operational: 50 },
        status: "operational",
      }),
      makeFacility({
        id: "b",
        name: "Bravo",
        capacityMw: { operational: 30 },
        status: "cancelled",
      }),
      makeFacility({
        id: "c",
        name: "Charlie",
        capacityMw: { planned: 10 },
        status: "proposed",
      }),
    ]);
    mockGetCryptoMiningStats.mockReset().mockResolvedValue({
      count: 3,
      operationalMw: 50,
      plannedMw: 10,
      stateCount: 1,
      stateCodes: ["TX"],
      includesDc: false,
    });

    const page = await CryptoPage();
    render(page);

    // Numerator (2) excludes the cancelled facility even though it discloses
    // 30 MW; denominator (3) is the full tracked count (stats.count) — same
    // convention as app/stats/page.tsx's disclosedCapacityCount.
    expect(
      screen.getByText(/Capacity is disclosed for 2 of the 3 tracked crypto-mining sites/)
    ).toBeInTheDocument();
  });

  it("includes every non-cancelled facility that discloses a capacity figure", async () => {
    mockGetCryptoMiningFacilities.mockReset().mockResolvedValue([
      makeFacility({
        id: "a",
        name: "Alpha",
        capacityMw: { operational: 50 },
        status: "operational",
      }),
      makeFacility({ id: "b", name: "Bravo", capacityMw: {}, status: "operational" }),
      makeFacility({
        id: "c",
        name: "Charlie",
        capacityMw: { planned: 10 },
        status: "proposed",
      }),
    ]);
    mockGetCryptoMiningStats.mockReset().mockResolvedValue({
      count: 3,
      operationalMw: 50,
      plannedMw: 10,
      stateCount: 1,
      stateCodes: ["TX"],
      includesDc: false,
    });

    const page = await CryptoPage();
    render(page);

    expect(
      screen.getByText(/Capacity is disclosed for 2 of the 3 tracked crypto-mining sites/)
    ).toBeInTheDocument();
  });

  it("reads N of N with no disclosure gap when every tracked facility publishes capacity", async () => {
    mockGetCryptoMiningFacilities.mockReset().mockResolvedValue([
      makeFacility({
        id: "a",
        name: "Alpha",
        capacityMw: { operational: 50 },
        status: "operational",
      }),
      makeFacility({
        id: "b",
        name: "Bravo",
        capacityMw: { planned: 20 },
        status: "proposed",
      }),
    ]);
    mockGetCryptoMiningStats.mockReset().mockResolvedValue({
      count: 2,
      operationalMw: 50,
      plannedMw: 20,
      stateCount: 1,
      stateCodes: ["TX"],
      includesDc: false,
    });

    const page = await CryptoPage();
    render(page);

    expect(
      screen.getByText(/Capacity is disclosed for 2 of the 2 tracked crypto-mining sites/)
    ).toBeInTheDocument();
  });
});

describe("CryptoPage — DC-aware states wording", () => {
  it("phrases the stat tile and prose as 'State + DC' / '1 state and DC', showing the state count (1) not the raw jurisdiction total (2), when the tracked codes include DC", async () => {
    mockGetCryptoMiningFacilities.mockReset().mockResolvedValue([
      makeFacility({ id: "a", location: { state: "DC" } }),
    ]);
    mockGetCryptoMiningStats.mockReset().mockResolvedValue({
      count: 1,
      operationalMw: 5,
      plannedMw: 0,
      stateCount: 2,
      stateCodes: ["DC", "TX"],
      includesDc: true,
    });

    const page = await CryptoPage();
    render(page);

    // Mutation coverage: reverting either call site back to a bare
    // `${stats.stateCount} states` template renders "2 states" instead.
    expect(screen.getByText(/across 1 state and DC\./)).toBeInTheDocument();
    // The bug this guards: the tile's rendered VALUE must be the state count
    // (1), not the raw jurisdiction total (2) — "2 / States + DC" reads as
    // "two states, plus DC." The "Facilities" tile legitimately also shows
    // "1" here (stats.count === 1), so the value check is scoped to the
    // states tile via its label rather than a bare screen.getByText("1").
    const statesTile = screen.getByText("State + DC").closest("div");
    expect(statesTile).not.toBeNull();
    expect(within(statesTile!).getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("States + DC")).not.toBeInTheDocument();
    expect(screen.queryByText("2 states")).not.toBeInTheDocument();
  });

  it("phrases the stat tile and prose as a bare count when no tracked code is DC", async () => {
    mockGetCryptoMiningFacilities.mockReset().mockResolvedValue([
      makeFacility({ id: "a", location: { state: "TX" } }),
    ]);
    mockGetCryptoMiningStats.mockReset().mockResolvedValue({
      count: 1,
      operationalMw: 5,
      plannedMw: 0,
      stateCount: 1,
      stateCodes: ["TX"],
      includesDc: false,
    });

    const page = await CryptoPage();
    render(page);

    expect(screen.getByText(/across 1 state\./)).toBeInTheDocument();
    expect(screen.getByText("State")).toBeInTheDocument();
  });
});
