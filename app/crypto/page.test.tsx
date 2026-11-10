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
  isUnverifiedMegaproject: (f: { capacityMw?: { planned?: number }; confidence?: string }) =>
    (f.capacityMw?.planned ?? 0) > 2000 && f.confidence !== "confirmed",
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

import CryptoPage, { metadata } from "./page";

// The by-state table also has a "State" column header; the stat tile label is
// the one that is not a table header.
function tileLabel(text: string) {
  return screen.getAllByText(text).find((el) => el.tagName !== "TH")!;
}

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
  it("marks the stat tile, footnotes DC, and phrases the prose '1 state and DC', showing the state count (1) not the raw jurisdiction total (2), when the tracked codes include DC", async () => {
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
    // (1), not the raw jurisdiction total (2) — "2 / States" over a footnote
    // naming DC reads as "two states, plus DC." The "Facilities" tile
    // legitimately also shows "1" here (stats.count === 1), so the value check
    // is scoped to the states tile via its label rather than a bare
    // screen.getByText("1").
    const statesTile = tileLabel("State").closest("div");
    expect(statesTile).not.toBeNull();
    expect(within(statesTile!).getByText("1")).toBeInTheDocument();
    expect(within(statesTile!).getByText("*")).toBeInTheDocument();
    expect(screen.getByText("Plus the District of Columbia")).toBeInTheDocument();
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
    expect(tileLabel("State")).toBeInTheDocument();
  });
});

function setup(facilities: ReturnType<typeof makeFacility>[]) {
  mockGetCryptoMiningFacilities.mockReset().mockResolvedValue(facilities);
  mockGetCryptoMiningStats.mockReset().mockResolvedValue({
    count: facilities.length,
    operationalMw: 0,
    plannedMw: 0,
    stateCount: 1,
    stateCodes: ["TX"],
    includesDc: false,
  });
}

async function renderPage() {
  render(await CryptoPage());
}

describe("CryptoPage — Bitcoin-first title", () => {
  it("leads the H1, title and description with Bitcoin", async () => {
    setup([makeFacility()]);
    await renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Bitcoin and crypto mining facilities in the United States" }),
    ).toBeInTheDocument();
    expect(String(metadata.title)).toContain("Bitcoin");
    expect(metadata.description).toContain("Bitcoin");
  });
});

describe("CryptoPage — Largest sites", () => {
  it("excludes cancelled, undisclosed and unverified megaprojects, caps at 10, orders by max MW", async () => {
    const real = Array.from({ length: 11 }, (_, i) =>
      makeFacility({ id: `r${i}`, name: `Real ${i}`, capacityMw: { operational: 10 + i } }),
    );
    setup([
      ...real,
      makeFacility({ id: "x", name: "Cancelled Giant", status: "cancelled", capacityMw: { planned: 900 } }),
      makeFacility({ id: "u", name: "Undisclosed Site", capacityMw: {} }),
      makeFacility({ id: "m", name: "Mega Claim", status: "proposed", capacityMw: { planned: 5000 } }),
    ]);
    await renderPage();
    const section = screen.getByRole("region", { name: "Largest sites" });
    const names = within(section).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(names).toHaveLength(10);
    expect(names[0]).toContain("Real 10");
    expect(names[9]).toContain("Real 1");
    expect(within(section).queryByText(/Cancelled Giant|Undisclosed Site|Mega Claim|Real 0/)).toBeNull();
  });
});

describe("CryptoPage — By state", () => {
  it("counts cancelled in Sites, skips them in MW, dashes undisclosed MW, links the state hub", async () => {
    setup([
      makeFacility({ id: "a", location: { state: "TX" }, capacityMw: { operational: 100, planned: 40 } }),
      makeFacility({ id: "b", location: { state: "TX" }, status: "cancelled", capacityMw: { operational: 900 } }),
      makeFacility({ id: "c", location: { state: "OH" }, capacityMw: {} }),
    ]);
    await renderPage();
    const section = screen.getByRole("region", { name: "By state" });
    const table = within(section).getByRole("table", { name: /by state/i });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "State",
      "Sites",
      "Operational",
      "Pipeline",
    ]);
    const tx = within(table).getByRole("link", { name: "Texas" });
    expect(tx).toHaveAttribute("href", "/states/texas");
    const txCells = within(tx.closest("tr")!).getAllByRole("cell").map((c) => c.textContent);
    expect(txCells[0]).toBe("2");
    expect(txCells[1]).toBe("100 MW");
    const ohCells = within(within(table).getByRole("link", { name: "Ohio" }).closest("tr")!)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(ohCells).toEqual(["1", "\u2014", "\u2014"]);
  });
});

describe("CryptoPage — By operator", () => {
  it("orders by sites then MW then name and links the operator hub", async () => {
    setup([
      makeFacility({ id: "1", operator: "Zed Co", capacityMw: { operational: 5 } }),
      makeFacility({ id: "2", operator: "Zed Co", capacityMw: { operational: 5 }, location: { state: "OH" } }),
      makeFacility({ id: "3", operator: "Big MW", capacityMw: { operational: 500 } }),
      makeFacility({ id: "4", operator: "Alpha Co", capacityMw: { operational: 1 } }),
    ]);
    await renderPage();
    const section = screen.getByRole("region", { name: "By operator" });
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("link")[0].textContent)).toEqual([
      "Zed Co",
      "Big MW",
      "Alpha Co",
    ]);
    expect(within(section).getByRole("link", { name: "Big MW" })).toHaveAttribute("href", "/operators/big-mw");
    expect(within(rows[0]).getByText("OH, TX")).toBeInTheDocument();
  });
});

describe("CryptoPage — By operator name tie-break", () => {
  it("sorts operators with equal sites and MW A to Z", async () => {
    setup([
      makeFacility({ id: "1", operator: "Beta Co", capacityMw: { operational: 5 } }),
      makeFacility({ id: "2", operator: "Alpha Co", capacityMw: { operational: 5 } }),
    ]);
    await renderPage();
    const rows = within(screen.getByRole("region", { name: "By operator" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("link")[0].textContent)).toEqual(["Alpha Co", "Beta Co"]);
  });
});

describe("CryptoPage — empty state", () => {
  it("renders none of the new sections", async () => {
    setup([]);
    await renderPage();
    for (const name of ["Largest sites", "By state", "By operator"]) {
      expect(screen.queryByRole("heading", { name })).toBeNull();
    }
  });
});
