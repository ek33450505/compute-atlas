import { vi, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import type { GapCount, GapDimension } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts (same
// pattern as app/crypto/page.test.tsx / app/facilities/[slug]/page.test.tsx).
const { mockGetDatasetGaps, mockGetGapExamples, mockGetStats } = vi.hoisted(() => ({
  mockGetDatasetGaps: vi.fn(),
  mockGetGapExamples: vi.fn(),
  mockGetStats: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getDatasetGaps: mockGetDatasetGaps,
  getGapExamples: mockGetGapExamples,
  getStats: mockGetStats,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (mirrors app/crypto/page.test.tsx). FieldGapPrompt is left real
// (not mocked): field-gap-prompt.test.tsx already covers its own branching,
// and app/facilities/[slug]/page.test.tsx renders it unmocked the same way.
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

import GapsPage from "./page";

const GAP_KEYS: GapDimension[] = [
  "capacity",
  "energy",
  "subsidies",
  "jobs",
  "water",
  "singleSource",
];

/** All 6 GapCount entries, defaulting to "everything covered" unless overridden per dimension. */
function makeGapCounts(overrides: Partial<Record<GapDimension, Partial<GapCount>>> = {}) {
  const base: GapCount = { fillableMissing: 0, fillableTotal: 10, allMissing: 0, allTotal: 15 };
  return Object.fromEntries(
    GAP_KEYS.map((key) => [key, { ...base, ...overrides[key] }])
  ) as Record<GapDimension, GapCount>;
}

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-id",
    name: "Test Site",
    operator: "Test Operator",
    location: { lat: 35, lon: -90, state: "TX", precision: "exact" },
    status: "operational",
    capacityMw: {},
    facilityType: "data_center",
    confidence: "reported",
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Source", retrievedAt: "2024-01-01", kind: "press" },
    ],
    lastUpdated: "2024-01-01",
    ...overrides,
  } as Facility;
}

describe("GapsPage", () => {
  it("renders the masthead, all 6 section headings, and the survey stat row without throwing", async () => {
    mockGetDatasetGaps.mockResolvedValue(makeGapCounts());
    mockGetGapExamples.mockResolvedValue([]);
    mockGetStats.mockResolvedValue({
      count: 1500,
      states: 40,
      operationalMw: 1000,
      plannedMw: 500,
      underConstructionMw: 200,
    });

    const page = await GapsPage();
    render(page);

    expect(
      screen.getByRole("heading", { level: 1, name: /where the dataset needs help/i })
    ).toBeInTheDocument();
    for (const label of ["Capacity", "Subsidies", "Jobs", "Energy", "Water", "Needs a second source"]) {
      expect(screen.getByRole("heading", { level: 2, name: label })).toBeInTheDocument();
    }
    expect(screen.getByText("1,500")).toBeInTheDocument();
  });

  it("handles the empty-gaps / no-examples case without throwing", async () => {
    // Every dimension fully covered, no example facilities anywhere.
    mockGetDatasetGaps.mockResolvedValue(makeGapCounts());
    mockGetGapExamples.mockResolvedValue([]);
    mockGetStats.mockResolvedValue({
      count: 0,
      states: 0,
      operationalMw: 0,
      plannedMw: 0,
      underConstructionMw: 0,
    });

    const page = await GapsPage();
    render(page);

    expect(
      screen.getAllByText(/no open examples on file right now/i).length
    ).toBe(GAP_KEYS.length);
  });

  it("renders the exact fillable/all counts for a dimension in the section sentence", async () => {
    mockGetDatasetGaps.mockResolvedValue(
      makeGapCounts({
        capacity: { fillableMissing: 444, fillableTotal: 945, allMissing: 738, allTotal: 1563 },
      })
    );
    mockGetGapExamples.mockResolvedValue([]);
    mockGetStats.mockResolvedValue({
      count: 1563,
      states: 40,
      operationalMw: 0,
      plannedMw: 0,
      underConstructionMw: 0,
    });

    const page = await GapsPage();
    render(page);

    expect(
      screen.getByText(/444 of 945 operational or under-construction sites carry no disclosed capacity figure/)
    ).toBeInTheDocument();
    expect(screen.getByText(/738 of 1563 sites are missing it/)).toBeInTheDocument();
  });

  it("renders an inline correction trigger for a correctable dimension (jobs) and a /contribute link for a non-correctable one (water)", async () => {
    mockGetDatasetGaps.mockResolvedValue(makeGapCounts());
    mockGetGapExamples.mockImplementation((dim: GapDimension) => {
      if (dim === "jobs") {
        return Promise.resolve([
          makeFacility({ id: "jobs-gap", name: "Jobsville DC", status: "operational" }),
        ]);
      }
      if (dim === "water") {
        return Promise.resolve([
          makeFacility({ id: "water-gap", name: "Waterville DC", status: "under_construction" }),
        ]);
      }
      return Promise.resolve([]);
    });
    mockGetStats.mockResolvedValue({
      count: 10,
      states: 5,
      operationalMw: 0,
      plannedMw: 0,
      underConstructionMw: 0,
    });

    const page = await GapsPage();
    render(page);

    // jobs is a CORRECTABLE_KEYS member — FieldGapPrompt renders a button
    // that opens SuggestCorrection pre-targeted at the field.
    expect(
      screen.getByRole("button", { name: /know permanent jobs\?/i })
    ).toBeInTheDocument();

    // water has no structured correction field yet — FieldGapPrompt falls
    // back to a plain /contribute link.
    const waterLink = screen.getByRole("link", {
      name: /know a source for the cooling method on waterville dc/i,
    });
    expect(waterLink).toHaveAttribute("href", "/contribute");

    // The example facility names/links themselves render too. The link's
    // accessible name includes both child spans (name + operator/location),
    // so match on a substring rather than the exact facility name.
    expect(screen.getByRole("link", { name: /jobsville dc/i })).toHaveAttribute(
      "href",
      "/facilities/jobs-gap"
    );
  });

  it("targets capacityOperationalMw for an operational example and capacityPlannedMw for an under_construction one", async () => {
    mockGetDatasetGaps.mockResolvedValue(makeGapCounts());
    mockGetGapExamples.mockImplementation((dim: GapDimension) => {
      if (dim === "capacity") {
        return Promise.resolve([
          makeFacility({ id: "op-cap", name: "Op Site", status: "operational", capacityMw: undefined }),
          makeFacility({ id: "uc-cap", name: "UC Site", status: "under_construction", capacityMw: undefined }),
        ]);
      }
      return Promise.resolve([]);
    });
    mockGetStats.mockResolvedValue({
      count: 10,
      states: 5,
      operationalMw: 0,
      plannedMw: 0,
      underConstructionMw: 0,
    });

    const page = await GapsPage();
    render(page);

    expect(
      screen.getByRole("button", { name: /know the operational capacity\?/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /know the planned capacity\?/i })
    ).toBeInTheDocument();
  });
});
