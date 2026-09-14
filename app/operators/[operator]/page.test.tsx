import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import type { OperatorSummary } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts (same
// pattern as app/states/[state]/page.test.tsx, app/data/page.test.tsx).
const {
  mockGetOperators,
  mockGetFacilitiesByOperator,
  mockGetOperatorSummary,
  mockOperatorSlug,
  mockGetOperatorBySlug,
} = vi.hoisted(() => ({
  mockGetOperators: vi.fn(),
  mockGetFacilitiesByOperator: vi.fn(),
  mockGetOperatorSummary: vi.fn(),
  mockOperatorSlug: vi.fn((name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
  ),
  mockGetOperatorBySlug: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getOperators: mockGetOperators,
  getFacilitiesByOperator: mockGetFacilitiesByOperator,
  getOperatorSummary: mockGetOperatorSummary,
  operatorSlug: mockOperatorSlug,
  getOperatorBySlug: mockGetOperatorBySlug,
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

import OperatorPage, { generateMetadata } from "./page";

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 30, lon: -97, city: "Austin", state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2026-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

function makeSummary(overrides: Partial<OperatorSummary> = {}): OperatorSummary {
  return {
    name: "Acme Corp",
    count: 2,
    operationalMw: 100,
    plannedMw: 0,
    byType: { data_center: 2, crypto_mining: 0, power_generation: 0 },
    byStatus: {
      operational: 2,
      under_construction: 0,
      permitted: 0,
      proposed: 0,
      cancelled: 0,
    },
    stateCount: 1,
    includesDc: false,
    stateCodes: ["TX"],
    capacityReporting: 2,
    ...overrides,
  } as OperatorSummary;
}

const FIXTURE_FACILITIES: Facility[] = [
  makeFacility({ id: "facility-1", name: "Facility One" }),
  makeFacility({ id: "facility-2", name: "Facility Two" }),
];

beforeEach(() => {
  mockGetOperators.mockReset();
  mockGetFacilitiesByOperator.mockReset();
  mockGetOperatorSummary.mockReset();
  mockGetOperatorBySlug.mockReset();

  mockGetOperatorBySlug.mockResolvedValue("Acme Corp");
  mockGetFacilitiesByOperator.mockResolvedValue(FIXTURE_FACILITIES);
  mockGetOperatorSummary.mockResolvedValue(makeSummary());
});

describe("OperatorPage JSON-LD", () => {
  it("emits BreadcrumbList and ItemList JSON-LD script tags with contiguous 1-indexed positions", async () => {
    const page = await OperatorPage({ params: Promise.resolve({ operator: "acme-corp" }) });
    const { container } = render(page);

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(2);

    const breadcrumb = JSON.parse(scripts[0]!.textContent!);
    expect(breadcrumb["@type"]).toBe("BreadcrumbList");
    expect(breadcrumb.itemListElement.map((i: { position: number }) => i.position)).toEqual([
      1, 2, 3,
    ]);
    expect(breadcrumb.itemListElement[0]).toMatchObject({
      position: 1,
      name: "Explore",
      item: "https://www.compute-atlas.com/explore",
    });
    expect(breadcrumb.itemListElement[2]).toMatchObject({ position: 3, name: "Acme Corp" });
    // Current (last) crumb has no href, so it must omit `item` per schema.org guidance.
    expect(breadcrumb.itemListElement[2].item).toBeUndefined();

    const itemList = JSON.parse(scripts[1]!.textContent!);
    expect(itemList["@type"]).toBe("ItemList");
    expect(itemList.itemListElement).toHaveLength(2);
    expect(itemList.itemListElement.map((i: { position: number }) => i.position)).toEqual([1, 2]);
    expect(itemList.itemListElement[0]).toEqual({
      "@type": "ListItem",
      position: 1,
      name: "Facility One",
      url: "https://www.compute-atlas.com/facilities/facility-1",
    });
    expect(itemList.itemListElement[1]).toEqual({
      "@type": "ListItem",
      position: 2,
      name: "Facility Two",
      url: "https://www.compute-atlas.com/facilities/facility-2",
    });
  });

  it("the rendered facility list matches the ItemList JSON-LD (same facilities, same order)", async () => {
    const page = await OperatorPage({ params: Promise.resolve({ operator: "acme-corp" }) });
    const { container } = render(page);

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    const itemList = JSON.parse(scripts[1]!.textContent!);
    const jsonLdNames = itemList.itemListElement.map((i: { name: string }) => i.name);

    const renderedNames = FIXTURE_FACILITIES.map((f) => f.name);
    expect(jsonLdNames).toEqual(renderedNames);
  });
});

describe("OperatorPage generateMetadata", () => {
  it("sets the canonical alternate to /operators/<slug>", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ operator: "acme-corp" }),
    });
    expect(metadata.alternates).toEqual({ canonical: "/operators/acme-corp" });
  });

  it("phrases the description as '1 state and DC' when the operator's summary includesDc", async () => {
    mockGetOperatorSummary.mockResolvedValue(
      makeSummary({ stateCount: 2, includesDc: true, stateCodes: ["DC", "VA"] })
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ operator: "acme-corp" }),
    });

    expect(metadata.description).toContain("across 1 state and DC —");
    expect(metadata.description).not.toContain("2 state(s)");
  });
});

describe("OperatorPage — DC-aware states stat and overview sentence", () => {
  it("labels the states tile 'State + DC', shows the state count (1) not the raw jurisdiction total (2), and phrases the overview sentence with DC when includesDc is true", async () => {
    mockGetOperatorSummary.mockResolvedValue(
      makeSummary({ stateCount: 2, includesDc: true, stateCodes: ["DC", "VA"] })
    );

    const page = await OperatorPage({ params: Promise.resolve({ operator: "acme-corp" }) });
    render(page);

    // Mutation coverage: reverting either call site back to a bare
    // `${summary.stateCount} state${...}` template renders "2 states" instead.
    expect(
      screen.getByText(/across 1 state and DC\. Operational capacity/)
    ).toBeInTheDocument();
    // The bug this guards: the tile's rendered VALUE must be the state count
    // (1), not the raw jurisdiction total (2) — "2 / States + DC" reads as
    // "two states, plus DC." The "Sites" tile legitimately also shows "2"
    // here (summary.count === 2), so the negative check is scoped to the
    // states tile rather than a page-wide queryByText("2"). Reverting the
    // call site to pass the raw total back to `value` fails that scoped
    // check; dropping containsDc/statesStat entirely fails the label half.
    const statesTile = screen.getByText("State + DC").closest("div");
    expect(statesTile).not.toBeNull();
    expect(within(statesTile!).getByText("1")).toBeInTheDocument();
    expect(within(statesTile!).queryByText("2")).not.toBeInTheDocument();
    expect(screen.queryByText("2 states")).not.toBeInTheDocument();
  });

  it("labels the states tile plain 'States' when includesDc is false", async () => {
    mockGetOperatorSummary.mockResolvedValue(
      makeSummary({ stateCount: 2, includesDc: false, stateCodes: ["CA", "TX"] })
    );

    const page = await OperatorPage({ params: Promise.resolve({ operator: "acme-corp" }) });
    render(page);

    expect(
      screen.getByText(/across 2 states\. Operational capacity/)
    ).toBeInTheDocument();
    expect(screen.getByText("States")).toBeInTheDocument();
  });
});
