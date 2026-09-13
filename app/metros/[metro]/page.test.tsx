import { vi, describe, it, expect, beforeEach } from "vitest";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetFacilitiesByMetro } = vi.hoisted(() => ({
  mockGetFacilitiesByMetro: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByMetro: mockGetFacilitiesByMetro,
}));

// Northern Virginia (the only currently-defined multi-state-adjacent DC-area
// metro) doesn't actually list DC in its `states` array today — inject a
// synthetic DC-spanning metro alongside the real ones so the DC-aware
// "spanning" phrasing has a fixture to exercise, without touching lib/metros.ts.
vi.mock("@/lib/metros", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metros")>();
  const DC_METRO = {
    slug: "dc-metro-test",
    name: "DC Metro Test",
    states: ["DC", "VA"],
    counties: [["DC", "Washington"], ["VA", "Arlington"]] as [string, string][],
  };
  return {
    ...actual,
    METROS: [...actual.METROS, DC_METRO],
    getMetroBySlug: (slug: string) =>
      slug === DC_METRO.slug ? DC_METRO : actual.getMetroBySlug(slug),
  };
});

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (CollectionPage's facility cards render Link internally).
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

import { render, screen } from "@testing-library/react";
import MetroPage, { generateMetadata } from "./page";

beforeEach(() => {
  mockGetFacilitiesByMetro.mockReset();
});

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Acme Corp",
    status: "proposed",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2025-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

describe("generateMetadata (metro)", () => {
  it("northern-virginia: title contains 'Northern Virginia'; description mentions the live count; canonical is /metros/northern-virginia", async () => {
    mockGetFacilitiesByMetro.mockResolvedValue([makeFacility(), makeFacility({ id: "two" })]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ metro: "northern-virginia" }),
    });

    expect(metadata.title).toBe("Data centers in Northern Virginia");
    expect(metadata.description).toContain("2 data centers");
    expect(metadata.description).toContain("Northern Virginia");
    expect(metadata.alternates).toEqual({ canonical: "/metros/northern-virginia" });
  });

  it("bay-area: title is 'Data centers in Bay Area & Silicon Valley'", async () => {
    mockGetFacilitiesByMetro.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ metro: "bay-area" }),
    });

    expect(metadata.title).toBe("Data centers in Bay Area & Silicon Valley");
    expect(metadata.alternates).toEqual({ canonical: "/metros/bay-area" });
  });

  it("returns a not-found title for an unknown metro slug, without querying the data layer", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ metro: "bogus" }),
    });

    expect(metadata).toEqual({ title: "Metro not found" });
    expect(mockGetFacilitiesByMetro).not.toHaveBeenCalled();
  });
});

describe("MetroPage — DC-aware 'spanning' phrasing", () => {
  it("phrases a DC-spanning metro as '1 state and DC'", async () => {
    mockGetFacilitiesByMetro.mockResolvedValue([
      makeFacility({ id: "a" }),
      makeFacility({ id: "b" }),
    ]);

    const page = await MetroPage({ params: Promise.resolve({ metro: "dc-metro-test" }) });
    render(page);

    // Mutation coverage: reverting to the bare `${metro.states.length} states`
    // template (dropping containsDc/statesPhrase) renders "2 states" instead.
    expect(screen.getByText(/spanning 1 state and DC/)).toBeInTheDocument();
    expect(screen.queryByText(/spanning 2 states/)).not.toBeInTheDocument();
  });

  it("omits DC wording for a single-state metro (no 'spanning' clause at all)", async () => {
    mockGetFacilitiesByMetro.mockResolvedValue([makeFacility()]);

    const page = await MetroPage({ params: Promise.resolve({ metro: "bay-area" }) });
    render(page);

    expect(screen.queryByText(/spanning/)).not.toBeInTheDocument();
  });
});
