import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { Metro } from "@/lib/metros";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
//
// `metrosBox` backs a live getter on the mocked `METROS` export so tests can
// swap in a DC-including fixture without touching the real data file —
// `metrosBox.real` is captured from the actual module inside the factory
// below and restored in beforeEach.
const { mockGetFacilitiesByMetro, metrosBox } = vi.hoisted(() => ({
  mockGetFacilitiesByMetro: vi.fn(),
  metrosBox: { current: [] as Metro[], real: [] as Metro[] },
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByMetro: mockGetFacilitiesByMetro,
}));

vi.mock("@/lib/metros", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metros")>();
  metrosBox.real = actual.METROS;
  metrosBox.current = actual.METROS;
  return {
    ...actual,
    get METROS() {
      return metrosBox.current;
    },
  };
});

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

import { METROS, metroCountyKey } from "@/lib/metros";
import MetrosIndexPage from "./page";

// Every metro resolves to the same facility count — count-per-metro (40)
// intentionally doesn't collide with any stat-row value computed below.
const FACILITIES_PER_METRO = 40;

/** The tile is the nearest wrapping div that holds exactly one figure + its caption. */
function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const tile = el.closest("div");
  if (!tile) throw new Error(`no tile wrapping "${text}"`);
  return tile;
}

beforeEach(() => {
  mockGetFacilitiesByMetro.mockReset();
  mockGetFacilitiesByMetro.mockResolvedValue(
    Array.from({ length: FACILITIES_PER_METRO })
  );
  // Reset to the real METROS fixture before every test; individual tests may
  // override metrosBox.current to inject a synthetic DC-including entry.
  metrosBox.current = metrosBox.real;
});

describe("MetrosIndexPage", () => {
  it("renders the overview section heading", async () => {
    const page = await MetrosIndexPage();
    render(page);

    expect(
      screen.getByRole("heading", { level: 2, name: "How a metro is defined" })
    ).toBeInTheDocument();
  });

  it("renders a 4-tile stat row derived from METROS, each value paired with its own label", async () => {
    // Independently derive expected Counties/States from the real METROS
    // data — mirrors the page's own derivation so a broken Set/key wiring
    // (not just an absent tile) would fail this assertion.
    const countyKeys = new Set<string>();
    const stateCodes = new Set<string>();
    for (const m of METROS) {
      for (const [state, county] of m.counties) {
        countyKeys.add(metroCountyKey(state, county));
      }
      for (const state of m.states) {
        stateCodes.add(state);
      }
    }
    const expectedFacilitiesInMetros = METROS.length * FACILITIES_PER_METRO;

    const page = await MetrosIndexPage();
    render(page);

    const tiles = [
      { value: METROS.length.toLocaleString(), label: "Metros" },
      { value: countyKeys.size.toLocaleString(), label: "Counties" },
      { value: stateCodes.size.toLocaleString(), label: "States" },
      { value: expectedFacilitiesInMetros.toLocaleString(), label: "In a metro" },
    ];

    for (const { value, label } of tiles) {
      expect(within(tileFor(value)).getByText(label)).toBeInTheDocument();
    }
    expect(
      tileFor(METROS.length.toLocaleString()).parentElement?.children
    ).toHaveLength(tiles.length);
  });

  it("labels the states tile 'States' — no metro in the real fixture lists DC", async () => {
    // Regression guard for the real fixture, not a synthetic one: as of this
    // writing no entry in lib/metros.ts includes "DC" in `states`, so the
    // live page must render the bare label.
    const page = await MetrosIndexPage();
    render(page);

    const stateCodes = new Set<string>();
    for (const m of METROS) {
      for (const state of m.states) stateCodes.add(state);
    }

    expect(
      within(tileFor(stateCodes.size.toLocaleString())).getByText("States")
    ).toBeInTheDocument();
    expect(
      within(tileFor(stateCodes.size.toLocaleString())).queryByText("States + DC")
    ).not.toBeInTheDocument();
  });

  it("labels the states tile 'States + DC' and shows the state count, not the raw jurisdiction total, when a metro's states include DC", async () => {
    // Synthetic fixture: append a DC-including metro to the real set via
    // metrosBox — proves containsDc/statesStat are actually wired into this
    // call site, rather than the label happening to read "States" because no
    // real metro exercises the DC branch.
    metrosBox.current = [
      ...metrosBox.real,
      {
        slug: "test-dc-metro",
        name: "Test DC Metro",
        states: ["DC"],
        counties: [["DC", "District of Columbia"]],
      },
    ];

    const page = await MetrosIndexPage();
    render(page);

    const rawStateTotal = new Set<string>();
    for (const m of metrosBox.current) {
      for (const state of m.states) rawStateTotal.add(state);
    }
    // The honest tile value: DC itself isn't a state, so it must not be
    // counted toward "States + DC" — this is the "51 / States + DC" bug's
    // regression case (here 21 raw jurisdictions -> 20 actual states).
    const expectedStatesValue = rawStateTotal.size - 1;

    // Mutation coverage: reverting the call site to a hardcoded "States"
    // label (dropping containsDc/statesStat) renders "States" here instead
    // and fails this assertion.
    expect(
      within(tileFor(expectedStatesValue.toLocaleString())).getByText("States + DC")
    ).toBeInTheDocument();
    expect(
      within(tileFor(expectedStatesValue.toLocaleString())).queryByText("States")
    ).not.toBeInTheDocument();
    // The bite: a call site that reverts to passing the raw jurisdiction
    // total as `value` still gets the label right and only this fails.
    expect(screen.queryByText(rawStateTotal.size.toLocaleString())).not.toBeInTheDocument();
  });
});
