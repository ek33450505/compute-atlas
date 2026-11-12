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
    kind: "person",
    roles: ["founder"],
    facilityCount: 1,
    operatorFacilityCount: 0,
    viaOperators: [],
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

    const page = await StakeholdersIndexPage({ searchParams: Promise.resolve({}) });
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

    const page = await StakeholdersIndexPage({ searchParams: Promise.resolve({}) });
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
  it("renders People / Organizations / Facility links / States tiles in order, counting by kind", async () => {
    mockGetStakeholders.mockResolvedValue([
      makePerson({ name: "Person A", slug: "person-a", facilityCount: 1, states: ["NY"] }),
      makePerson({ name: "Person B", slug: "person-b", facilityCount: 1, states: ["TX"] }),
      makePerson({ name: "Fund C", slug: "fund-c", kind: "organization", facilityCount: 1, states: ["TX"] }),
    ]);

    const page = await StakeholdersIndexPage({ searchParams: Promise.resolve({}) });
    render(page);

    const tiles = [
      { label: "People", value: "2" },
      { label: "Organizations", value: "1" },
      { label: "Facility links", value: "3" },
      { label: "States", value: "2" },
    ];
    for (const { label, value } of tiles) {
      expect(within(tileByLabel(label)).getByText(value)).toBeInTheDocument();
    }
    expect(tileByLabel("People").parentElement?.children).toHaveLength(tiles.length);
  });
});

describe("StakeholdersIndexPage — operator-level owners", () => {
  it("shows 'via N operators' instead of a site count on an owner-only card, and no via line on a site-only card", async () => {
    mockGetStakeholders.mockResolvedValue([
      makePerson({
        name: "Example Capital",
        slug: "example-capital",
        kind: "organization",
        roles: ["controlling_owner"],
        facilityCount: 0,
        operatorFacilityCount: 3,
        viaOperators: [
          {
            operator: "Acme Corp",
            slug: "acme-corp",
            facilityCount: 3,
            owner: {
              name: "Example Capital",
              kind: "organization",
              role: "controlling_owner",
              source: { url: "https://example.com/own", label: "Filing", retrievedAt: "2026-11-04", kind: "filing" },
              asOf: "2026-11-04",
            },
          },
        ],
        states: ["TX"],
      }),
      makePerson({ name: "Jane Doe", slug: "jane-doe" }),
    ]);

    render(await StakeholdersIndexPage({ searchParams: Promise.resolve({}) }));

    const ownerCard = screen.getByRole("link", { name: /Example Capital/ });
    expect(within(ownerCard).getByText("via 1 operator")).toBeInTheDocument();
    expect(within(ownerCard).queryByText(/0 sites/)).not.toBeInTheDocument();
    const personCard = screen.getByRole("link", { name: /Jane Doe/ });
    expect(within(personCard).queryByText(/via /)).not.toBeInTheDocument();
    expect(within(personCard).getByText("1 site")).toBeInTheDocument();
  });

  it("shows both the site count and 'via N operators' for a name with both kinds of stake", async () => {
    const via = {
      operator: "Acme Corp",
      slug: "acme-corp",
      facilityCount: 3,
      owner: {
        name: "Jane Doe",
        kind: "person" as const,
        role: "investor" as const,
        source: { url: "https://example.com/own", label: "Filing", retrievedAt: "2026-11-04", kind: "filing" as const },
        asOf: "2026-11-04",
      },
    };
    mockGetStakeholders.mockResolvedValue([
      makePerson({ name: "Jane Doe", slug: "jane-doe", facilityCount: 2, viaOperators: [via, { ...via, operator: "Beta Co", slug: "beta-co" }] }),
    ]);

    render(await StakeholdersIndexPage({ searchParams: Promise.resolve({}) }));

    const card = screen.getByRole("link", { name: /Jane Doe/ });
    expect(within(card).getByText("2 sites")).toBeInTheDocument();
    expect(within(card).getByText("via 2 operators")).toBeInTheDocument();
  });
});

describe("StakeholdersIndexPage — A–Z paging", () => {
  const people = [
    makePerson({ name: "Alice Adams", slug: "alice-adams", facilityCount: 1 }),
    makePerson({ name: "Zed Zane", slug: "zed-zane", facilityCount: 5 }),
    makePerson({ name: "Zoe Zimmer", slug: "zoe-zimmer", facilityCount: 2 }),
  ];

  beforeEach(() => {
    mockGetStakeholders.mockResolvedValue(people);
  });

  it("links only letters that hold a name and lists everyone on the default view while small", async () => {
    render(await StakeholdersIndexPage({ searchParams: Promise.resolve({}) }));

    const nav = screen.getByRole("navigation", { name: "Stakeholders by first letter" });
    expect(within(nav).getByRole("link", { name: "Z" })).toHaveAttribute(
      "href",
      "/stakeholders?letter=z",
    );
    expect(within(nav).queryByRole("link", { name: "B" })).not.toBeInTheDocument();
  });

  it("lists only the chosen letter's names, A to Z, and marks it current", async () => {
    render(await StakeholdersIndexPage({ searchParams: Promise.resolve({ letter: "z" }) }));

    expect(screen.getByRole("link", { name: /Zed Zane/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Zoe Zimmer/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Alice Adams/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Stakeholders starting with Z" }),
    ).toBeInTheDocument();
  });

  it("falls back to the default view for an invalid letter", async () => {
    render(await StakeholdersIndexPage({ searchParams: Promise.resolve({ letter: "zz" }) }));

    expect(
      screen.getByRole("heading", { name: /stakeholders tied to the most sites/ }),
    ).toBeInTheDocument();
  });
});
