import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { CountySummary } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const { mockGetCounties, mockGetAllFacilities } = vi.hoisted(() => ({
  mockGetCounties: vi.fn(),
  mockGetAllFacilities: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getCounties: mockGetCounties,
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

import CountiesIndexPage from "./page";

function makeCounty(overrides: Partial<CountySummary> = {}): CountySummary {
  return {
    slug: "test-county-xx",
    name: "Test",
    state: "XX",
    count: 1,
    ...overrides,
  };
}

/** The tile is the nearest wrapping div that holds exactly one figure + its caption. */
function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const tile = el.closest("div");
  if (!tile) throw new Error(`no tile wrapping "${text}"`);
  return tile;
}

// 3 counties across 2 states (VA gets 2 counties, the 3rd state slot is
// swapped between AZ and DC per test) — chosen so Counties (3) / States (2)
// / In a county (6) are three distinct rendered values, and no facility
// lacks a county (getAllFacilities length === the county total), so no test
// here accidentally depends on the withoutCounty prose.
function countiesFixture(thirdState: "AZ" | "DC", thirdName: string): CountySummary[] {
  return [
    makeCounty({ slug: "loudoun-va", name: "Loudoun", state: "VA", count: 3 }),
    makeCounty({ slug: "fairfax-va", name: "Fairfax", state: "VA", count: 2 }),
    makeCounty({ slug: `${thirdName.toLowerCase()}-${thirdState.toLowerCase()}`, name: thirdName, state: thirdState, count: 1 }),
  ];
}

beforeEach(() => {
  mockGetCounties.mockReset();
  mockGetAllFacilities.mockReset();
  mockGetAllFacilities.mockResolvedValue(Array.from({ length: 6 }));
});

describe("CountiesIndexPage", () => {
  it("labels the states tile 'States' when no tracked county is in DC", async () => {
    mockGetCounties.mockResolvedValue(countiesFixture("AZ", "Maricopa"));

    const page = await CountiesIndexPage();
    render(page);

    // 2 distinct states (VA, AZ) — mutation coverage: reverting the label
    // to a hardcoded "States" also passes this half, so the DC case below
    // is what actually proves containsDc/statesStat are wired in.
    expect(within(tileFor("2")).getByText("States")).toBeInTheDocument();
    expect(within(tileFor("2")).queryByText("*")).not.toBeInTheDocument();
    expect(screen.queryByText(/Plus the District of Columbia/)).not.toBeInTheDocument();
  });

  it("marks the states tile and footnotes DC, showing the state count (1), not the raw jurisdiction total (2), when a tracked county is in DC", async () => {
    // Mirrors the live record: coresite-dc1-washington-d-c-dc carries
    // location.county "District of Columbia" / location.state "DC".
    mockGetCounties.mockResolvedValue(countiesFixture("DC", "District of Columbia"));

    const page = await CountiesIndexPage();
    render(page);

    // The bug this guards: the tile's rendered VALUE must be the state count
    // (1: just VA), not the raw jurisdiction total (2: VA + DC) — "2 / States"
    // over a footnote naming DC reads as "two states, plus DC." Reverting the
    // call site to pass the raw total back to `value` fails this positive and
    // the "2" negative below; dropping statesStat entirely leaves the caption
    // unmarked and un-footnoted, which fails the other two.
    expect(within(tileFor("1")).getByText("State")).toBeInTheDocument();
    expect(within(tileFor("1")).getByText("*")).toBeInTheDocument();
    expect(screen.getByText("Plus the District of Columbia")).toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("renders a 3-tile stat row with Counties / States(+DC) / In a county", async () => {
    mockGetCounties.mockResolvedValue(countiesFixture("AZ", "Maricopa"));

    const page = await CountiesIndexPage();
    render(page);

    const tiles = [
      { value: "3", label: "Counties" },
      { value: "2", label: "States" },
      { value: "6", label: "In a county" },
    ];
    for (const { value, label } of tiles) {
      expect(within(tileFor(value)).getByText(label)).toBeInTheDocument();
    }
    expect(tileFor("3").parentElement?.children).toHaveLength(tiles.length);
  });
});
