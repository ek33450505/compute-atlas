import { vi, describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";

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
});
