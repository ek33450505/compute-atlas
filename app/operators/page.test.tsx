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

import OperatorsIndexPage, { generateMetadata } from "./page";

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
    includesDc: false,
    stateCodes: [],
    capacityReporting: 0,
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
    const page = await OperatorsIndexPage({ searchParams: Promise.resolve({}) });
    render(page);

    expect(
      screen.getByRole("heading", { level: 2, name: "How the list is organized" })
    ).toBeInTheDocument();
  });

  it("renders a 4-tile stat row, each value paired with its own label", async () => {
    const page = await OperatorsIndexPage({ searchParams: Promise.resolve({}) });
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

  it("gives each disclosed-capacity link an accessible name with a pluralized unit, not a bare number", async () => {
    const page = await OperatorsIndexPage({ searchParams: Promise.resolve({}) });
    render(page);

    // A bare count (no "site(s)" suffix) would make the link's accessible
    // name read as a naked integer to a screen reader — assert the unit is
    // part of the *name*, not just present somewhere in the page text.
    expect(screen.getByRole("link", { name: /Acme Corp.*8 sites/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Beta LLC.*4 sites/i })).toBeInTheDocument();
  });

  it("uses the singular unit for a single-site operator on its letter page", async () => {
    const page = await OperatorsIndexPage({ searchParams: Promise.resolve({ letter: "s" }) });
    render(page);

    // Silent Co has count: 1 and zero disclosed capacity, so it is absent from
    // the default view and listed only under its letter. (?!s) rather than a
    // leading \b: JSX drops the whitespace-only text node between sibling spans
    // on separate source lines, so the computed name runs on as
    // "...capacity1 site" with no boundary before the digit.
    expect(screen.getByRole("link", { name: /Silent Co.*1 site(?!s)/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Silent Co.*1 sites/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Acme Corp/i })).not.toBeInTheDocument();
  });

  it("omits operators with no disclosed capacity from the default view", async () => {
    render(await OperatorsIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("link", { name: /Silent Co/i })).not.toBeInTheDocument();
  });

  it("links a crawlable letter page for every letter that holds an operator", async () => {
    render(await OperatorsIndexPage({ searchParams: Promise.resolve({}) }));
    const nav = screen.getByRole("navigation", { name: "Operators by first letter" });
    for (const l of ["a", "b", "s"]) {
      expect(
        within(nav)
          .getAllByRole("link")
          .some((a) => a.getAttribute("href") === `/operators?letter=${l}`)
      ).toBe(true);
    }
    // No operator starts with Z, so no link leads to an empty page.
    expect(within(nav).queryByRole("link", { name: "Z" })).not.toBeInTheDocument();
  });

  it.each([["zz"], [""], [["a", "b"]], ["../x"], [undefined]])(
    "falls back to the default view for an invalid letter %j",
    async (letter) => {
      render(await OperatorsIndexPage({ searchParams: Promise.resolve({ letter }) }));
      expect(screen.getByRole("link", { name: /Acme Corp/i })).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 2, name: /Largest 2 operators/ })
      ).toBeInTheDocument();
    }
  );

  describe("metadata", () => {
    it("uses the bare canonical with no letter and with an invalid letter", async () => {
      for (const letter of [undefined, "zz", ["a", "b"]]) {
        const meta = await generateMetadata({ searchParams: Promise.resolve({ letter }) });
        expect(meta.alternates?.canonical).toBe("/operators");
        expect(meta.title).not.toMatch(/: /);
      }
    });

    it("is self-canonical with its own title for a letter page", async () => {
      const meta = await generateMetadata({ searchParams: Promise.resolve({ letter: "c" }) });
      expect(meta.alternates?.canonical).toBe("/operators?letter=c");
      expect(meta.title).toMatch(/: .*C$/);
    });
  });

  describe("ItemList JSON-LD", () => {
    function itemCount(container: HTMLElement): number {
      const script = container.querySelector('script[type="application/ld+json"]');
      return JSON.parse(script!.textContent!).itemListElement.length;
    }

    it("lists exactly the rows rendered on the default view", async () => {
      
      const { container } = render(await OperatorsIndexPage({ searchParams: Promise.resolve({}) }));
      const rows = container.querySelectorAll('li a[href^="/operators/"]').length;
      expect(rows).toBeGreaterThan(0);
      expect(itemCount(container)).toBe(rows);
    });

    it("lists exactly the rows rendered on a letter page", async () => {
      
      const { container } = render(
        await OperatorsIndexPage({ searchParams: Promise.resolve({ letter: "s" }) })
      );
      const rows = container.querySelectorAll('li a[href^="/operators/"]').length;
      expect(rows).toBe(1);
      expect(itemCount(container)).toBe(rows);
    });
  });
});
