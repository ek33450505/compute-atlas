import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { StateSummary } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const { mockGetStates, mockGetStateSummary, mockGetAllFacilities } = vi.hoisted(
  () => ({
    mockGetStates: vi.fn(),
    mockGetStateSummary: vi.fn(),
    mockGetAllFacilities: vi.fn(),
  })
);

vi.mock("@/lib/data", () => ({
  getStates: mockGetStates,
  getStateSummary: mockGetStateSummary,
  getAllFacilities: mockGetAllFacilities,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
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

import StatesIndexPage from "./page";

function makeStateSummary(overrides: Partial<StateSummary> = {}): StateSummary {
  return {
    code: "XX",
    count: 0,
    operationalMw: 0,
    plannedMw: 0,
    underConstructionMw: 0,
    byType: { data_center: 0, crypto_mining: 0, power_generation: 0 },
    byStatus: {
      operational: 0,
      under_construction: 0,
      permitted: 0,
      proposed: 0,
      cancelled: 0,
    },
    communityFriction: 0,
    communityReporting: 0,
    capacityReporting: 0,
    topOperators: [],
    ...overrides,
  };
}

// Chosen so no two rendered numbers on the page coincide as exact text:
// per-row counts (10, 5) vs. stat-row values (2, "1,234", "800 MW", "250 MW").
const SUMMARIES: Record<string, StateSummary> = {
  VA: makeStateSummary({ code: "VA", count: 10, operationalMw: 500, plannedMw: 150 }),
  TX: makeStateSummary({ code: "TX", count: 5, operationalMw: 300, plannedMw: 100 }),
};

/** The tile is the nearest wrapping div that holds exactly one figure + its caption. */
function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const tile = el.closest("div");
  if (!tile) throw new Error(`no tile wrapping "${text}"`);
  return tile;
}

beforeEach(() => {
  mockGetStates.mockReset();
  mockGetStateSummary.mockReset();
  mockGetAllFacilities.mockReset();
  mockGetStates.mockResolvedValue(Object.keys(SUMMARIES));
  mockGetStateSummary.mockImplementation((code: string) =>
    Promise.resolve(SUMMARIES[code] ?? null)
  );
  // Length 1,234 (not just "large") specifically to prove the stat row
  // applies toLocaleString() rather than interpolating the raw number.
  mockGetAllFacilities.mockResolvedValue(Array.from({ length: 1234 }));
});

describe("StatesIndexPage", () => {
  it("renders the overview section heading", async () => {
    const page = await StatesIndexPage();
    render(page);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "What the ranking does and doesn't say",
      })
    ).toBeInTheDocument();
  });

  it("renders a 4-tile stat row, each value paired with its own label", async () => {
    const page = await StatesIndexPage();
    render(page);

    const tiles = [
      { value: "2", label: "States" },
      { value: "1,234", label: "Facilities" },
      { value: "800 MW", label: "Operational" },
      { value: "250 MW", label: "Pipeline" },
    ];

    for (const { value, label } of tiles) {
      expect(within(tileFor(value)).getByText(label)).toBeInTheDocument();
    }
    // Same tile count check the shared SurveyStatRow suite runs, scoped here
    // to prove StatesIndexPage actually passes exactly these 4 stats.
    expect(tileFor("2").parentElement?.children).toHaveLength(tiles.length);
  });

  it("labels the states tile 'State + DC' and shows the state count (1), not the raw jurisdiction total (2), when a tracked code is DC", async () => {
    mockGetStates.mockResolvedValue(["VA", "DC"]);
    mockGetStateSummary.mockImplementation((code: string) =>
      Promise.resolve(
        makeStateSummary({ code, count: 1, operationalMw: 10, plannedMw: 0 })
      )
    );

    const page = await StatesIndexPage();
    render(page);

    // The bug this guards: the tile's rendered VALUE must be the state count
    // (1), not the raw jurisdiction total (2) — "2 / States + DC" reads as
    // "two states, plus DC." Per-state row badges also render "1" (each
    // state's facility count), so this is scoped to the tile via its label
    // rather than tileFor("1").
    const statesTile = screen.getByText("State + DC").closest("div");
    expect(statesTile).not.toBeNull();
    expect(within(statesTile!).getByText("1")).toBeInTheDocument();
    expect(within(statesTile!).queryByText("2")).not.toBeInTheDocument();
    expect(within(statesTile!).queryByText("States")).not.toBeInTheDocument();
  });

  it("renders a District of Columbia and U.S. territories section, and keeps DC and the territory out of the states list", async () => {
    mockGetStates.mockResolvedValue(["VA", "TX", "DC", "PR"]);
    mockGetStateSummary.mockImplementation((code: string) =>
      Promise.resolve(makeStateSummary({ code, count: 1 }))
    );

    const page = await StatesIndexPage();
    render(page);

    const otherSection = screen.getByRole("region", {
      name: "District of Columbia and U.S. territories",
    });
    expect(
      within(otherSection).getByText("District of Columbia")
    ).toBeInTheDocument();
    expect(within(otherSection).getByText("Puerto Rico")).toBeInTheDocument();

    const statesSection = screen.getByRole("region", { name: "The 50 states" });
    expect(
      within(statesSection).queryByText("District of Columbia")
    ).not.toBeInTheDocument();
    expect(within(statesSection).queryByText("Puerto Rico")).not.toBeInTheDocument();
    expect(within(statesSection).getByText("Virginia")).toBeInTheDocument();
    expect(within(statesSection).getByText("Texas")).toBeInTheDocument();
  });

  it("omits the District of Columbia and U.S. territories section entirely when every tracked code is one of the 50 states", async () => {
    mockGetStates.mockResolvedValue(["VA", "TX"]);
    mockGetStateSummary.mockImplementation((code: string) =>
      Promise.resolve(makeStateSummary({ code, count: 1 }))
    );

    const page = await StatesIndexPage();
    render(page);

    expect(
      screen.queryByRole("heading", {
        name: "District of Columbia and U.S. territories",
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", {
        name: "District of Columbia and U.S. territories",
      })
    ).not.toBeInTheDocument();
  });

  it("covers both the states group and the DC/territories group in the ItemList JSON-LD", async () => {
    mockGetStates.mockResolvedValue(["VA", "TX", "DC", "PR"]);
    mockGetStateSummary.mockImplementation((code: string) =>
      Promise.resolve(makeStateSummary({ code, count: 1 }))
    );

    const page = await StatesIndexPage();
    const { container } = render(page);

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);
    const itemList = JSON.parse(scripts[0]!.textContent!);
    expect(itemList.numberOfItems).toBe(4);
    expect(itemList.itemListElement).toHaveLength(4);
    const names = itemList.itemListElement.map((i: { name: string }) => i.name);
    expect(names).toEqual(
      expect.arrayContaining(["Virginia", "Texas", "District of Columbia", "Puerto Rico"])
    );
  });
});
