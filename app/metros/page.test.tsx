import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { METROS, metroCountyKey } from "@/lib/metros";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetFacilitiesByMetro } = vi.hoisted(() => ({
  mockGetFacilitiesByMetro: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByMetro: mockGetFacilitiesByMetro,
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
});
