import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { StakeholderSummary } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const { mockGetStakeholders } = vi.hoisted(() => ({
  mockGetStakeholders: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStakeholders: mockGetStakeholders,
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

import StakeholdersIndexPage from "./page";

function makePerson(overrides: Partial<StakeholderSummary> = {}): StakeholderSummary {
  return {
    name: "Test Person",
    slug: "test-person",
    roles: ["founder"],
    facilityCount: 1,
    states: ["NY"],
    ...overrides,
  };
}

/**
 * Locates a survey-stat tile by its LABEL (not its bare number) — several
 * people can legitimately share the same `facilityCount`, so bare-number
 * lookups risk ambiguity. Scoped to the tile caption's specific
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
  mockGetStakeholders.mockReset();
});

describe("StakeholdersIndexPage — states tile DC wording", () => {
  it("labels the states tile 'States' and shows the state count when no stakeholder's facilities are in DC", async () => {
    mockGetStakeholders.mockResolvedValue([
      makePerson({ name: "Person A", slug: "person-a", states: ["NY"] }),
      makePerson({ name: "Person B", slug: "person-b", states: ["TX"] }),
    ]);

    const page = await StakeholdersIndexPage();
    render(page);

    // 2 distinct states (NY, TX), no DC.
    expect(within(tileByLabel("States")).getByText("2")).toBeInTheDocument();
    expect(within(tileByLabel("States")).queryByText("*")).not.toBeInTheDocument();
    expect(screen.queryByText(/Plus the District of Columbia/)).not.toBeInTheDocument();
  });

  it("marks the states tile and footnotes DC, showing the state count (2), not the raw jurisdiction total (3), when a stakeholder's facility is in DC", async () => {
    mockGetStakeholders.mockResolvedValue([
      makePerson({ name: "Person A", slug: "person-a", states: ["NY", "DC"] }),
      makePerson({ name: "Person B", slug: "person-b", states: ["TX"] }),
    ]);

    const page = await StakeholdersIndexPage();
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

describe("StakeholdersIndexPage — survey stat row", () => {
  it("renders People / Facility links / States tiles in order", async () => {
    mockGetStakeholders.mockResolvedValue([
      makePerson({ name: "Person A", slug: "person-a", facilityCount: 1, states: ["NY"] }),
      makePerson({ name: "Person B", slug: "person-b", facilityCount: 1, states: ["TX"] }),
    ]);

    const page = await StakeholdersIndexPage();
    render(page);

    const tiles = [
      { label: "People", value: "2" },
      { label: "Facility links", value: "2" },
      { label: "States", value: "2" },
    ];
    for (const { label, value } of tiles) {
      expect(within(tileByLabel(label)).getByText(value)).toBeInTheDocument();
    }
    expect(tileByLabel("People").parentElement?.children).toHaveLength(tiles.length);
  });
});
