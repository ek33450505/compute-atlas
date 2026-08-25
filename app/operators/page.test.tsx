import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { OperatorSummary } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const { mockGetOperators, mockGetOperatorSummary, mockGetAllFacilities } = vi.hoisted(
  () => ({
    mockGetOperators: vi.fn(),
    mockGetOperatorSummary: vi.fn(),
    mockGetAllFacilities: vi.fn(),
  })
);

vi.mock("@/lib/data", () => ({
  getOperators: mockGetOperators,
  getOperatorSummary: mockGetOperatorSummary,
  getAllFacilities: mockGetAllFacilities,
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

import OperatorsIndexPage from "./page";

function makeOperatorSummary(overrides: Partial<OperatorSummary> = {}): OperatorSummary {
  return {
    name: "XX",
    count: 0,
    operationalMw: 0,
    plannedMw: 0,
    byType: { data_center: 0, crypto_mining: 0, power_generation: 0 },
    byStatus: {
      operational: 0,
      under_construction: 0,
      permitted: 0,
      proposed: 0,
      cancelled: 0,
    },
    stateCount: 0,
    ...overrides,
  };
}

// Chosen so no two rendered numbers on the page coincide as exact text:
// per-row counts (8, 4, 1) vs. stat-row values (3, 2, "2,500", "750 MW").
const SUMMARIES: Record<string, OperatorSummary> = {
  "Acme Corp": makeOperatorSummary({
    name: "Acme Corp",
    count: 8,
    operationalMw: 400,
    plannedMw: 100,
  }),
  "Beta LLC": makeOperatorSummary({
    name: "Beta LLC",
    count: 4,
    operationalMw: 200,
    plannedMw: 50,
  }),
  "Silent Co": makeOperatorSummary({
    name: "Silent Co",
    count: 1,
    operationalMw: 0,
    plannedMw: 0,
  }),
};

/** The tile is the nearest wrapping div that holds exactly one figure + its caption. */
function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const tile = el.closest("div");
  if (!tile) throw new Error(`no tile wrapping "${text}"`);
  return tile;
}

beforeEach(() => {
  mockGetOperators.mockReset();
  mockGetOperatorSummary.mockReset();
  mockGetAllFacilities.mockReset();
  mockGetOperators.mockResolvedValue(Object.keys(SUMMARIES));
  mockGetOperatorSummary.mockImplementation((name: string) =>
    Promise.resolve(SUMMARIES[name] ?? null)
  );
  // Length 2,500 specifically to prove the stat row applies toLocaleString()
  // rather than interpolating the raw number.
  mockGetAllFacilities.mockResolvedValue(Array.from({ length: 2500 }));
});

describe("OperatorsIndexPage", () => {
  it("renders the overview section heading", async () => {
    const page = await OperatorsIndexPage();
    render(page);

    expect(
      screen.getByRole("heading", { level: 2, name: "Why the list is split" })
    ).toBeInTheDocument();
  });

  it("renders a 4-tile stat row, each value paired with its own label", async () => {
    const page = await OperatorsIndexPage();
    render(page);

    const tiles = [
      { value: "3", label: "Operators" },
      { value: "2", label: "With capacity" },
      { value: "2,500", label: "Facilities" },
      { value: "750 MW", label: "Disclosed" },
    ];

    for (const { value, label } of tiles) {
      expect(within(tileFor(value)).getByText(label)).toBeInTheDocument();
    }
    expect(tileFor("3").parentElement?.children).toHaveLength(tiles.length);
  });
});
