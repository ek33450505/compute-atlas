import { vi, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

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
    });

    const page = await CryptoPage();
    render(page);

    expect(
      screen.getByText(/Capacity is disclosed for 2 of the 2 tracked crypto-mining sites/)
    ).toBeInTheDocument();
  });
});
