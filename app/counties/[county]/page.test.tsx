import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import type { CountySummary } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
// Mirrors app/metros/[metro]/page.test.tsx.
const { mockGetCountyBySlug, mockGetFacilitiesByCounty } = vi.hoisted(() => ({
  mockGetCountyBySlug: vi.fn(),
  mockGetFacilitiesByCounty: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getCounties: vi.fn(),
  getCountyBySlug: mockGetCountyBySlug,
  getFacilitiesByCounty: mockGetFacilitiesByCounty,
}));

// next/link renders to <a> — mocked to avoid a Next.js router-context
// dependency in jsdom (same pattern as app/explore/page.test.tsx).
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

import CountyPage, { generateMetadata } from "./page";

beforeEach(() => {
  mockGetCountyBySlug.mockReset();
  mockGetFacilitiesByCounty.mockReset();
});

function makeCounty(overrides: Partial<CountySummary> = {}): CountySummary {
  return { slug: "loudoun-va", name: "Loudoun", state: "VA", count: 2, ...overrides };
}

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

describe("generateMetadata (county)", () => {
  it("loudoun-va: title carries the civil-division word and state name; description mentions the live count; canonical is /counties/loudoun-va", async () => {
    mockGetCountyBySlug.mockResolvedValue(makeCounty());
    mockGetFacilitiesByCounty.mockResolvedValue([
      makeFacility(),
      makeFacility({ id: "two" }),
    ]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ county: "loudoun-va" }),
    });

    expect(metadata.title).toBe("Data centers in Loudoun County, Virginia");
    expect(metadata.description).toContain("2 data centers");
    expect(metadata.description).toContain("Loudoun County, Virginia");
    expect(metadata.alternates).toEqual({ canonical: "/counties/loudoun-va" });
  });

  it("rapides-la: Louisiana counties are labelled Parish, not County", async () => {
    mockGetCountyBySlug.mockResolvedValue(
      makeCounty({ slug: "rapides-la", name: "Rapides", state: "LA", count: 1 })
    );
    mockGetFacilitiesByCounty.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ county: "rapides-la" }),
    });

    expect(metadata.title).toBe("Data centers in Rapides Parish, Louisiana");
    expect(metadata.alternates).toEqual({ canonical: "/counties/rapides-la" });
  });

  it("st-louis-city-mo: an independent city keeps its own name, with no County appended", async () => {
    mockGetCountyBySlug.mockResolvedValue(
      makeCounty({ slug: "st-louis-city-mo", name: "St. Louis city", state: "MO", count: 1 })
    );
    mockGetFacilitiesByCounty.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ county: "st-louis-city-mo" }),
    });

    expect(metadata.title).toBe("Data centers in St. Louis city, Missouri");
    expect(metadata.title).not.toContain("County");
  });

  it("returns a not-found title for an unknown county slug, without querying the facility reader", async () => {
    mockGetCountyBySlug.mockResolvedValue(undefined);

    const metadata = await generateMetadata({
      params: Promise.resolve({ county: "bogus" }),
    });

    expect(metadata).toEqual({ title: "County not found" });
    expect(mockGetFacilitiesByCounty).not.toHaveBeenCalled();
  });
});

/**
 * The disambiguation guard. 73 county names occur in more than one state,
 * covering 203 of the 636 hubs — "Washington" alone is a county in GA, LA,
 * MS, NE, OH, OR, PA, TN and UT. generateMetadata has always qualified the
 * <title> by state; these tests pin the RENDERED page to the same contract,
 * because an H1 and a breadcrumb trail repeated verbatim across nine URLs is
 * a near-duplicate signal on a lens that exists to be a search surface.
 *
 * Written to FAIL against a page whose title is `Data centers in ${label}`:
 * both renders would produce the identical string, so the exact-match
 * assertions and the not-equal assertion all break. A test that would pass
 * either way would be worse than no test here.
 */
describe("CountyPage headings disambiguate same-named counties by state", () => {
  async function renderCounty(county: {
    slug: string;
    name: string;
    state: string;
    count: number;
  }) {
    mockGetCountyBySlug.mockResolvedValue(county);
    // Empty on purpose: it exercises the emptyMessage branch (which must also
    // name the state) and keeps the render off the facility-card grid.
    mockGetFacilitiesByCounty.mockResolvedValue([]);
    const { unmount } = render(await CountyPage({
      params: Promise.resolve({ county: county.slug }),
    }));
    const heading = screen.getByRole("heading", { level: 1 }).textContent ?? "";
    const trail =
      screen.getByRole("navigation", { name: /breadcrumb/i }).textContent ?? "";
    const empty = screen.getByText(/no facilities are on file yet/i).textContent ?? "";
    unmount();
    return { heading, trail, empty };
  }

  const WASHINGTON_OR = {
    slug: "washington-or",
    name: "Washington",
    state: "OR",
    count: 3,
  };
  const WASHINGTON_UT = {
    slug: "washington-ut",
    name: "Washington",
    state: "UT",
    count: 2,
  };

  it("washington-or and washington-ut render DIFFERENT h1 headings", async () => {
    const or = await renderCounty(WASHINGTON_OR);
    const ut = await renderCounty(WASHINGTON_UT);

    expect(or.heading).toBe("Data centers in Washington County, Oregon");
    expect(ut.heading).toBe("Data centers in Washington County, Utah");
    expect(or.heading).not.toBe(ut.heading);
  });

  it("washington-or and washington-ut render DIFFERENT breadcrumb trails", async () => {
    const or = await renderCounty(WASHINGTON_OR);
    const ut = await renderCounty(WASHINGTON_UT);

    expect(or.trail).toContain("Washington County, Oregon");
    expect(ut.trail).toContain("Washington County, Utah");
    expect(or.trail).not.toBe(ut.trail);
  });

  it("the empty-state message names the state too", async () => {
    const or = await renderCounty(WASHINGTON_OR);
    const ut = await renderCounty(WASHINGTON_UT);

    expect(or.empty).toBe(
      "No facilities are on file yet for Washington County, Oregon."
    );
    expect(or.empty).not.toBe(ut.empty);
  });

  it("the h1 agrees with the <title> generateMetadata produces for the same slug", async () => {
    const { heading } = await renderCounty(WASHINGTON_OR);

    mockGetCountyBySlug.mockResolvedValue(WASHINGTON_OR);
    mockGetFacilitiesByCounty.mockResolvedValue([]);
    const metadata = await generateMetadata({
      params: Promise.resolve({ county: WASHINGTON_OR.slug }),
    });

    // The defect this whole block exists for was precisely a page whose
    // <title> and <h1> disagreed, so pin them to each other.
    expect(heading).toBe(metadata.title);
  });
});
