import { vi, describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import type { GapCount, GapDimension } from "@/lib/data";
import { CORRECTABLE_KEYS } from "@/lib/contribute-fields";

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

import GapsPage, { GAP_SECTIONS } from "./page";

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

  it("renders an inline correction trigger for a correctable dimension (jobs) and a /contribute link for a non-correctable one (needs a second source)", async () => {
    mockGetDatasetGaps.mockResolvedValue(makeGapCounts());
    mockGetGapExamples.mockImplementation((dim: GapDimension) => {
      if (dim === "jobs") {
        return Promise.resolve([
          makeFacility({ id: "jobs-gap", name: "Jobsville DC", status: "operational" }),
        ]);
      }
      if (dim === "singleSource") {
        return Promise.resolve([
          makeFacility({ id: "source-gap", name: "Sourceville DC", status: "under_construction" }),
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

    // singleSource ("secondSource") is the one remaining non-correctable
    // dimension — FieldGapPrompt falls back to a plain /contribute link.
    const sourceLink = screen.getByRole("link", {
      name: /know a source for additional corroboration on sourceville dc/i,
    });
    expect(sourceLink).toHaveAttribute("href", "/contribute");

    // The example facility names/links themselves render too. The link's
    // accessible name includes both child spans (name + operator/location),
    // so match on a substring rather than the exact facility name.
    expect(screen.getByRole("link", { name: /jobsville dc/i })).toHaveAttribute(
      "href",
      "/facilities/jobs-gap"
    );
  });

  // -------------------------------------------------------------------------
  // Drift guard: the italic "Correctable directly below" / "No structured
  // correction field yet" note under each section's "Where to look" is
  // DERIVED (via isCorrectable in page.tsx) from CORRECTABLE_KEYS rather than
  // a second, hand-maintained boolean per section — that hand-maintained
  // boolean is exactly what drifted when CORRECTABLE_KEYS widened 2026-09-11
  // to add water/energy, leaving a working correction button under a note
  // that said no such form existed. This test renders the real page and
  // checks the note against the actual rendered affordance (button vs link)
  // for every GAP_SECTIONS entry, using the real CORRECTABLE_KEYS import —
  // so a regression to a stale/hand-maintained flag fails here even though
  // no boolean literal remains in page.tsx to eyeball.
  // -------------------------------------------------------------------------
  it("the correctable note under 'Where to look' agrees with the actual affordance rendered for every dimension", async () => {
    mockGetDatasetGaps.mockResolvedValue(makeGapCounts());
    mockGetGapExamples.mockImplementation((dim: GapDimension) =>
      Promise.resolve([
        makeFacility({ id: `${dim}-example`, name: `${dim} Example DC`, status: "operational" }),
      ])
    );
    mockGetStats.mockResolvedValue({
      count: 10,
      states: 5,
      operationalMw: 0,
      plannedMw: 0,
      underConstructionMw: 0,
    });

    const page = await GapsPage();
    render(page);

    expect(GAP_SECTIONS.length).toBeGreaterThan(0);

    for (const section of GAP_SECTIONS) {
      const region = screen.getByRole("region", { name: section.label });
      const { field } = section.gapPromptFor({ status: "operational" });
      const expectCorrectable = (CORRECTABLE_KEYS as readonly string[]).includes(field);

      if (expectCorrectable) {
        expect(
          within(region).getByText(/correctable directly below/i)
        ).toBeInTheDocument();
        expect(within(region).queryAllByRole("button").length).toBeGreaterThan(0);
        expect(
          within(region).queryAllByRole("link", { name: /know a source for/i }).length
        ).toBe(0);
      } else {
        expect(
          within(region).getByText(/no structured correction field yet/i)
        ).toBeInTheDocument();
        expect(within(region).queryAllByRole("button").length).toBe(0);
        expect(
          within(region).queryAllByRole("link", { name: /know a source for/i }).length
        ).toBeGreaterThan(0);
      }
    }
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
