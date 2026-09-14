import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const {
  mockGetStats,
  mockGetFacilitiesRankedByPlannedMw,
  mockGetTopOperatorsByCapacity,
  mockGetTopStatesByCapacity,
} = vi.hoisted(() => ({
  mockGetStats: vi.fn(),
  mockGetFacilitiesRankedByPlannedMw: vi.fn(),
  mockGetTopOperatorsByCapacity: vi.fn(),
  mockGetTopStatesByCapacity: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStats: mockGetStats,
  getFacilitiesRankedByPlannedMw: mockGetFacilitiesRankedByPlannedMw,
  getTopOperatorsByCapacity: mockGetTopOperatorsByCapacity,
  getTopStatesByCapacity: mockGetTopStatesByCapacity,
  // Identity is enough here — hrefs/slugs aren't under test in this file.
  operatorSlug: (name: string) => name,
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

import RankingsPage from "./page";

/**
 * Locates a survey-stat tile by its LABEL (not its bare number) — a per-row
 * figure in the rankings lists below can coincidentally match a tile's
 * number. Scoped to the tile caption's specific
 * `<span class="... text-muted-foreground">` to uniquely identify it.
 */
function tileByLabel(label: string): HTMLElement {
  const matches = screen
    .getAllByText(label)
    .filter(
      (el) => el.tagName === "SPAN" && el.classList.contains("text-muted-foreground")
    );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one survey-stat tile labeled "${label}", found ${matches.length}`
    );
  }
  const tile = matches[0].closest("div");
  if (!tile) throw new Error(`no tile wrapping label "${label}"`);
  return tile;
}

beforeEach(() => {
  mockGetStats.mockReset();
  // Empty rankings lists throughout — these tests are about the states tile
  // on the shared `stats` object, not the per-dimension rankings themselves.
  mockGetFacilitiesRankedByPlannedMw.mockReset().mockResolvedValue([]);
  mockGetTopOperatorsByCapacity.mockReset().mockResolvedValue([]);
  mockGetTopStatesByCapacity.mockReset().mockResolvedValue([]);
});

describe("RankingsPage — states tile DC wording", () => {
  it("labels the states tile 'States' and shows the state count when stats.includesDc is false", async () => {
    mockGetStats.mockResolvedValue({
      count: 5,
      states: 2,
      stateCodes: ["CA", "TX"],
      includesDc: false,
      operationalMw: 500,
      plannedMw: 300,
      underConstructionMw: 100,
    });

    const page = await RankingsPage();
    render(page);

    expect(within(tileByLabel("States")).getByText("2")).toBeInTheDocument();
    expect(within(tileByLabel("States")).queryByText("*")).not.toBeInTheDocument();
    expect(screen.queryByText(/Plus the District of Columbia/)).not.toBeInTheDocument();
  });

  it("marks the states tile and footnotes DC, showing the state count (2), not the raw jurisdiction total (3), when stats.includesDc is true", async () => {
    mockGetStats.mockResolvedValue({
      count: 5,
      states: 3,
      stateCodes: ["CA", "DC", "TX"],
      includesDc: true,
      operationalMw: 500,
      plannedMw: 300,
      underConstructionMw: 100,
    });

    const page = await RankingsPage();
    render(page);

    // The bug this guards: the tile's VALUE must be the state count (2), not
    // the raw jurisdiction total (3) — "3 / States + DC" reads as "three
    // states, plus DC."
    const tile = tileByLabel("States");
    expect(within(tile).getByText("2")).toBeInTheDocument();
    expect(within(tile).queryByText("3")).not.toBeInTheDocument();
    expect(within(tile).getByText("*")).toBeInTheDocument();
    expect(screen.getByText("Plus the District of Columbia")).toBeInTheDocument();
  });
});

describe("RankingsPage — survey stat row", () => {
  it("renders Facilities / States / Operational / Pipeline tiles in order", async () => {
    mockGetStats.mockResolvedValue({
      count: 5,
      states: 2,
      stateCodes: ["CA", "TX"],
      includesDc: false,
      operationalMw: 500,
      plannedMw: 300,
      underConstructionMw: 100,
    });

    const page = await RankingsPage();
    render(page);

    const tiles = [
      { label: "Facilities", value: "5" },
      { label: "States", value: "2" },
      { label: "Operational", value: "500 MW" },
      { label: "Pipeline", value: "300 MW" },
    ];
    for (const { label, value } of tiles) {
      expect(within(tileByLabel(label)).getByText(value)).toBeInTheDocument();
    }
    expect(tileByLabel("Facilities").parentElement?.children).toHaveLength(tiles.length);
  });
});
