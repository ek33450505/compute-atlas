import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const {
  mockGetFacilitiesByCommunityStatus,
  mockGetCommunityReceptionCounts,
  mockGetNotableOppositionCases,
  mockGetDefeatedProjects,
} = vi.hoisted(() => ({
  mockGetFacilitiesByCommunityStatus: vi.fn(),
  mockGetCommunityReceptionCounts: vi.fn(),
  mockGetNotableOppositionCases: vi.fn(),
  mockGetDefeatedProjects: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByCommunityStatus: mockGetFacilitiesByCommunityStatus,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
  getNotableOppositionCases: mockGetNotableOppositionCases,
  getDefeatedProjects: mockGetDefeatedProjects,
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

import OppositionPage from "./page";

/** Loosely-typed fixture — only the fields this page's "the sites" list reads. */
type FixtureFacility = {
  id: string;
  name: string;
  operator: string;
  status: string;
  location: { state: string };
  community?: { notes?: string };
};

function makeFacility(overrides: Partial<FixtureFacility> = {}): FixtureFacility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: "operational",
    location: { state: "NY" },
    ...overrides,
  };
}

/**
 * Locates a survey-stat tile by its LABEL (not its bare number) — bare
 * numbers can coincidentally repeat elsewhere in the rendered facility list.
 * Some labels (e.g. "In litigation") also appear as a `§ By reception`
 * PercentageBar label (in a `<span class="text-foreground">`, not the
 * masthead/tile caption's `<span class="... text-muted-foreground">`), so
 * this is scoped to that specific tag+class combination, not just matching text.
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
  mockGetFacilitiesByCommunityStatus.mockReset();
  mockGetCommunityReceptionCounts.mockReset();
  mockGetNotableOppositionCases.mockReset().mockResolvedValue([]);
  mockGetDefeatedProjects.mockReset().mockResolvedValue([]);
});

describe("OppositionPage — states tile DC wording", () => {
  it("labels the states tile 'States' and shows the state count when no friction site is in DC", async () => {
    const byStatus: Record<string, FixtureFacility[]> = {
      litigation: [makeFacility({ id: "lit-1", location: { state: "NY" } })],
      opposed: [makeFacility({ id: "opp-1", location: { state: "TX" } })],
      contested: [],
    };
    mockGetFacilitiesByCommunityStatus.mockImplementation((status: string) =>
      Promise.resolve(byStatus[status] ?? [])
    );
    mockGetCommunityReceptionCounts.mockResolvedValue({
      supported: 0,
      mixed: 0,
      contested: 0,
      opposed: 1,
      litigation: 1,
      unknown: 0,
    });

    const page = await OppositionPage();
    render(page);

    // 2 distinct friction states (NY, TX), no DC.
    expect(within(tileByLabel("States")).getByText("2")).toBeInTheDocument();
    expect(within(tileByLabel("States")).queryByText("*")).not.toBeInTheDocument();
    expect(screen.queryByText(/Plus the District of Columbia/)).not.toBeInTheDocument();
  });

  it("marks the states tile and footnotes DC, showing the state count (2), not the raw jurisdiction total (3), when a friction site is in DC", async () => {
    const byStatus: Record<string, FixtureFacility[]> = {
      litigation: [makeFacility({ id: "lit-1", location: { state: "NY" } })],
      opposed: [makeFacility({ id: "opp-1", location: { state: "TX" } })],
      contested: [makeFacility({ id: "con-1", location: { state: "DC" } })],
    };
    mockGetFacilitiesByCommunityStatus.mockImplementation((status: string) =>
      Promise.resolve(byStatus[status] ?? [])
    );
    mockGetCommunityReceptionCounts.mockResolvedValue({
      supported: 0,
      mixed: 0,
      contested: 1,
      opposed: 1,
      litigation: 1,
      unknown: 0,
    });

    const page = await OppositionPage();
    render(page);

    // The bug this guards: the tile's VALUE must be the state count (2: NY,
    // TX), not the raw jurisdiction total (3: NY, TX, DC) — "3 / States" over
    // a footnote naming DC reads as "three states, plus DC."
    const tile = tileByLabel("States");
    expect(within(tile).getByText("2")).toBeInTheDocument();
    expect(within(tile).queryByText("3")).not.toBeInTheDocument();
    expect(within(tile).getByText("*")).toBeInTheDocument();
    expect(screen.getByText("Plus the District of Columbia")).toBeInTheDocument();
  });
});

describe("OppositionPage — survey stat row", () => {
  it("renders Friction sites / In litigation / States tiles in order", async () => {
    const byStatus: Record<string, FixtureFacility[]> = {
      litigation: [makeFacility({ id: "lit-1", location: { state: "NY" } })],
      opposed: [makeFacility({ id: "opp-1", location: { state: "TX" } })],
      contested: [],
    };
    mockGetFacilitiesByCommunityStatus.mockImplementation((status: string) =>
      Promise.resolve(byStatus[status] ?? [])
    );
    mockGetCommunityReceptionCounts.mockResolvedValue({
      supported: 0,
      mixed: 0,
      contested: 0,
      opposed: 1,
      litigation: 1,
      unknown: 0,
    });

    const page = await OppositionPage();
    render(page);

    const tiles = [
      { label: "Friction sites", value: "2" },
      { label: "In litigation", value: "1" },
      { label: "States", value: "2" },
    ];
    for (const { label, value } of tiles) {
      expect(within(tileByLabel(label)).getByText(value)).toBeInTheDocument();
    }
    // No defeated projects in this fixture, so the row has exactly these 3 tiles.
    expect(tileByLabel("Friction sites").parentElement?.children).toHaveLength(tiles.length);
  });
});
