import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Facility } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const { mockGetFacilitiesByOperator, mockGetFacilitiesByStateCached } = vi.hoisted(() => ({
  mockGetFacilitiesByOperator: vi.fn(),
  mockGetFacilitiesByStateCached: vi.fn(),
}));

// Only the two DB-touching readers are mocked; operatorSlug (pure, already
// exercised elsewhere) is kept real via importOriginal so hrefs reflect the
// actual slugify logic rather than a re-implementation in this test file.
vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    getFacilitiesByOperator: mockGetFacilitiesByOperator,
    getFacilitiesByStateCached: mockGetFacilitiesByStateCached,
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

import { RelatedFacilities } from "./related-facilities";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "current-site",
    name: "Current Site",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2025-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

const CURRENT = makeFacility();

beforeEach(() => {
  mockGetFacilitiesByOperator.mockReset();
  mockGetFacilitiesByStateCached.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
//
// RelatedFacilities is an async Server Component. React Testing Library's
// client renderer cannot render an async component's JSX invocation
// directly — call the component function and await its resolved output
// before handing it to render() (same pattern as power-links.test.tsx).
// ---------------------------------------------------------------------------

describe("RelatedFacilities", () => {
  it("renders both the operator and state groups with working footer links", async () => {
    mockGetFacilitiesByOperator.mockResolvedValue([
      CURRENT,
      makeFacility({
        id: "acme-two",
        name: "Acme Two",
        location: { lat: 41, lon: -91, city: "Peoria", state: "IL", precision: "exact" },
      }),
    ]);
    mockGetFacilitiesByStateCached.mockResolvedValue([
      CURRENT,
      makeFacility({ id: "other-il-site", name: "Other IL Site", operator: "Other Operator" }),
    ]);

    const result = await RelatedFacilities({ facility: CURRENT });
    render(result);

    expect(screen.getByRole("heading", { name: "More from Acme Corp" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Acme Two/ })).toHaveAttribute(
      "href",
      "/facilities/acme-two"
    );
    expect(screen.getByRole("link", { name: "All Acme Corp sites →" })).toHaveAttribute(
      "href",
      "/operators/acme-corp"
    );

    expect(
      screen.getByRole("heading", { name: "Other data centers in Illinois" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Other IL Site/ })).toHaveAttribute(
      "href",
      "/facilities/other-il-site"
    );
    expect(screen.getByRole("link", { name: "All Illinois →" })).toHaveAttribute(
      "href",
      "/states/illinois"
    );
  });

  it("excludes the current facility from both groups", async () => {
    // Operator list has only the current facility -> empty after filtering.
    mockGetFacilitiesByOperator.mockResolvedValue([CURRENT]);
    mockGetFacilitiesByStateCached.mockResolvedValue([
      CURRENT,
      makeFacility({ id: "other-il-site", name: "Other IL Site" }),
    ]);

    const result = await RelatedFacilities({ facility: CURRENT });
    render(result);

    // Operator group ended up empty -> its heading is absent entirely.
    expect(screen.queryByRole("heading", { name: /More from/ })).not.toBeInTheDocument();

    // The current facility is never linked, in either group.
    const facilityHrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href): href is string => !!href?.startsWith("/facilities/"));
    expect(facilityHrefs).not.toContain("/facilities/current-site");
    expect(facilityHrefs).toEqual(["/facilities/other-il-site"]);
  });

  it("caps each group at 6 facilities", async () => {
    const eightOthers = Array.from({ length: 8 }, (_, i) =>
      makeFacility({ id: `acme-${i}`, name: `Acme Site ${i}` })
    );
    mockGetFacilitiesByOperator.mockResolvedValue([CURRENT, ...eightOthers]);
    mockGetFacilitiesByStateCached.mockResolvedValue([CURRENT]);

    const result = await RelatedFacilities({ facility: CURRENT });
    render(result);

    const facilityLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/facilities/"));
    expect(facilityLinks).toHaveLength(6);
  });

  it("returns null when both groups are empty", async () => {
    mockGetFacilitiesByOperator.mockResolvedValue([CURRENT]);
    mockGetFacilitiesByStateCached.mockResolvedValue([CURRENT]);

    const result = await RelatedFacilities({ facility: CURRENT });
    expect(result).toBeNull();
  });
});
