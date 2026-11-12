import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const {
  mockGetFacilityByIdCached,
  mockGetSitingContext,
  mockGetOperatorOwnership,
  stakeholdersProps,
  sitingSectionProps,
  printGapProps,
  mockMissingRecordItems,
} = vi.hoisted(() => ({
  mockGetFacilityByIdCached: vi.fn(),
  mockGetSitingContext: vi.fn(),
  mockGetOperatorOwnership: vi.fn(),
  stakeholdersProps: vi.fn(),
  sitingSectionProps: vi.fn(),
  printGapProps: vi.fn(),
  mockMissingRecordItems: vi.fn(),
}));

// operatorSlug is real (imported from the dependency-free lib/operator-slug
// leaf via vi.importActual) — it's a pure slugify, no reason to stub it and
// stubbing it would decouple the masthead operator-link href from reality.
vi.mock("@/lib/data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/operator-slug")>(
    "@/lib/operator-slug"
  );
  return {
    getFacilityByIdCached: mockGetFacilityByIdCached,
    getAllFacilityIds: vi.fn(),
    operatorSlug: actual.operatorSlug,
  };
});

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (mirrors app/stakeholders/[person]/page.test.tsx).
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

// The masthead-only tests below stub out every other facility-page section.
// Several (PowerLinksSection, RelatedFacilities) are async Server Components,
// which plain ReactDOM/RTL rendering in jsdom can't resolve — and the rest
// are owned by sibling agents editing these files concurrently in this same
// wave, so stubbing keeps this test isolated from unrelated in-flight edits.
vi.mock("@/components/facility/status-timeline", () => ({
  StatusTimeline: () => null,
}));
vi.mock("@/components/facility/provenance-panel", () => ({
  ProvenancePanel: () => null,
}));
vi.mock("@/components/facility/facility-mini-map-dynamic", () => ({
  FacilityMiniMapDynamic: () => null,
}));
vi.mock("@/components/facility/civic-impact", () => ({
  CivicImpactSection: () => null,
}));
vi.mock("@/components/facility/stakeholders", () => ({
  StakeholdersSection: (props: unknown) => {
    stakeholdersProps(props);
    return null;
  },
}));
vi.mock("@/lib/siting-context", () => ({ getSitingContext: mockGetSitingContext }));
vi.mock("@/lib/operator-ownership", () => ({ getOperatorOwnership: mockGetOperatorOwnership }));
vi.mock("@/components/facility/power-links", () => ({
  PowerLinksSection: () => null,
  hasPowerLinks: async () => true,
}));
vi.mock("@/components/facility/siting-context", () => ({
  SitingContextSection: (props: unknown) => {
    sitingSectionProps(props);
    return null;
  },
}));
vi.mock("@/components/facility/related-facilities", () => ({
  RelatedFacilities: () => null,
}));
// Async Server Component (it awaits missingSectionLabels, which queries the
// power-link datasets). Its own behavior is covered by lib/facility-gaps.test.ts
// and e2e/print-brief.spec.ts.
vi.mock("@/components/facility/print-gap-summary", () => ({
  PrintGapSummary: (props: unknown) => {
    printGapProps(props);
    return null;
  },
}));

// facility-gaps pulls the predicates out of the section modules stubbed above;
// its own list is covered by lib/facility-gaps.test.ts, so only the seam the
// page uses is faked here.
vi.mock("@/lib/facility-gaps", () => ({
  CAPACITY_NOT_RECORDED_KEY: {
    capacityOperationalMw: "capacityMw.operational",
    capacityPlannedMw: "capacityMw.planned",
  },
  missingRecordItems: mockMissingRecordItems,
  firstCorrectableField: (items: { field?: string }[]) => items.find((i) => i.field)?.field,
}));

import FacilityPage, { generateMetadata } from "./page";

beforeEach(() => {
  mockMissingRecordItems.mockReset();
  mockMissingRecordItems.mockReturnValue([]);
});

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: {
      lat: 40,
      lon: -90,
      city: "Springfield",
      state: "IL",
    },
    statusHistory: [],
    sources: [{ url: "https://example.com", title: "Example source" }],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

describe("generateMetadata", () => {
  it("data_center: title is '{name} — {operator} data center in {city}, {ST}'; description mentions data center", async () => {
    const facility = makeFacility({
      name: "Colossus",
      operator: "xAI",
      facilityType: "data_center",
      location: { lat: 35.1, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "colossus" }),
    });

    expect(metadata.title).toBe("Colossus — xAI data center in Memphis, TN");
    expect(metadata.description).toContain("data center");
  });

  it("power_generation: title AND description say power-generation facility, and neither contains 'data center' (regression for the type-label bug)", async () => {
    // Name deliberately avoids the power_generation redundancy keywords
    // ("solar"/"wind"/"power plant"/"power station"/"generating station") so
    // this test isolates the data-center-mislabel regression, not the
    // type-redundancy-omission behavior (covered separately below).
    const facility = makeFacility({
      name: "Riverbend Generation Campus",
      operator: "NextEra Energy",
      facilityType: "power_generation",
      location: { lat: 32.7, lon: -97.3, city: "Fort Worth", state: "TX", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "riverbend-generation-campus" }),
    });

    expect(metadata.title).toContain("power-generation facility");
    expect(metadata.description).toContain("power-generation facility");
    expect(metadata.title).not.toContain("data center");
    expect(metadata.description).not.toContain("data center");
  });

  it("crypto_mining: title and description say crypto-mining facility", async () => {
    const facility = makeFacility({
      name: "Hash Farm One",
      operator: "Riot Platforms",
      facilityType: "crypto_mining",
      location: { lat: 30.6, lon: -97.0, city: "Rockdale", state: "TX", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "hash-farm-one" }),
    });

    expect(metadata.title).toContain("crypto-mining facility");
    expect(metadata.description).toContain("crypto-mining facility");
  });

  it("omits the operator when it's already embedded in the facility name (case-insensitive)", async () => {
    const facility = makeFacility({
      name: "Google Council Bluffs",
      operator: "Google",
      facilityType: "data_center",
      location: { lat: 41.3, lon: -95.9, city: "Council Bluffs", state: "IA", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "google-council-bluffs" }),
    });

    const title = metadata.title as string;
    expect(title).toBe("Google Council Bluffs — data center in Council Bluffs, IA");
    // "Google" appears exactly once — no "Google ... Google" duplication.
    expect(title.split("Google").length - 1).toBe(1);
  });

  it("falls back to the full state name (not the bare code or 'undefined') when city is missing", async () => {
    const facility = makeFacility({
      name: "Remote Generating Station",
      operator: "Acme Power",
      facilityType: "power_generation",
      location: { lat: 31.0, lon: -99.0, city: undefined, state: "TX", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "remote-generating-station" }),
    });

    const title = metadata.title as string;
    expect(title).toContain("Texas");
    expect(title).not.toContain("undefined");
    expect(title).not.toMatch(/,\s*,/);
  });

  it("returns a not-found title (unchanged branch) when the facility doesn't exist", async () => {
    mockGetFacilityByIdCached.mockResolvedValue(undefined);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "missing-slug" }),
    });

    expect(metadata).toEqual({ title: "Facility not found" });
  });

  it("strips a legal suffix ('CleanSpark, Inc.') before checking operator redundancy, and also omits the type label since the name says 'Bitcoin Mining Facility'", async () => {
    const facility = makeFacility({
      name: "CleanSpark Dalton Bitcoin Mining Facility",
      operator: "CleanSpark, Inc.",
      facilityType: "crypto_mining",
      location: { lat: 34.8, lon: -84.9, city: "Dalton", state: "GA", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "cleanspark-dalton" }),
    });

    const title = metadata.title as string;
    // Without suffix-stripping, ", Inc." would defeat the substring match and
    // "CleanSpark" would print twice — assert it appears exactly once.
    expect(title.split(/cleanspark/i).length - 1).toBe(1);
    expect(title).toBe("CleanSpark Dalton Bitcoin Mining Facility — Dalton, GA");
  });

  it("strips a legal suffix ('Applied Digital Corporation') before checking operator redundancy", async () => {
    const facility = makeFacility({
      name: "Applied Digital Polaris Forge 1",
      operator: "Applied Digital Corporation",
      facilityType: "data_center",
      location: { lat: 47.9, lon: -97.0, city: "Harwood", state: "ND", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "applied-digital-polaris-forge-1" }),
    });

    const title = metadata.title as string;
    expect(title.split(/applied digital/i).length - 1).toBe(1);
    expect(title).toBe("Applied Digital Polaris Forge 1 — data center in Harwood, ND");
  });

  it("omits the type label but keeps the operator when only the name conveys the type (operator not redundant)", async () => {
    const facility = makeFacility({
      name: "Riverbend Solar Array",
      operator: "NextEra Energy",
      facilityType: "power_generation",
      location: { lat: 32.7, lon: -97.3, city: "Fort Worth", state: "TX", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "riverbend-solar-array" }),
    });

    // "Solar" in the name makes "power-generation facility" redundant, but
    // the operator ("NextEra Energy") is unrelated to the name and stays.
    expect(metadata.title).toBe("Riverbend Solar Array — NextEra Energy in Fort Worth, TX");
  });
});

// ---------------------------------------------------------------------------
// Masthead gaps — capacity, powered-by and announced date no longer carry an
// on-screen invite (the page's one "What this record is missing" card lists
// them). The rows stay so the printed brief keeps its hidden "Not recorded"
// nil beside each <dt>; those markers must not change.
// ---------------------------------------------------------------------------

function printNils(container: HTMLElement) {
  return container.querySelectorAll("[data-print-nil]");
}

describe("FacilityPage masthead — capacity / powered-by / announced gaps", () => {
  it("shows no inline prompt for missing capacity, powered-by or announced date, but keeps one print nil marker per row", async () => {
    const facility = makeFacility({
      name: "Gapville Data Center",
      // capacityMw, poweredBy, announcedDate all deliberately omitted.
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const page = await FacilityPage({
      params: Promise.resolve({ slug: "test-facility" }),
    });
    const { container } = render(page);

    expect(screen.queryByRole("button", { name: /know /i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Send us a link/)).not.toBeInTheDocument();
    expect(printNils(container)).toHaveLength(3);
    for (const nil of printNils(container)) expect(nil).toHaveTextContent("Not recorded");
  });

  it("renders 'Not recorded' with the reason instead of a prompt for a marked capacity", async () => {
    mockGetFacilityByIdCached.mockResolvedValue(
      makeFacility({
        notRecorded: { "capacityMw.operational": "The 107 MW figure is company-wide, not this site." },
      })
    );
    const page = await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) });
    const { container } = render(page);
    expect(
      screen.getByText(/Not recorded — The 107 MW figure is company-wide, not this site\./)
    ).toBeInTheDocument();
    expect(printNils(container)).toHaveLength(2);
  });

  it("shows the reason for a marked operational capacity beside a recorded planned figure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reason = "The 107 MW figure is company-wide, not this site.";
    mockGetFacilityByIdCached.mockResolvedValue(
      makeFacility({
        status: "under_construction",
        capacityMw: { planned: 300 },
        notRecorded: { "capacityMw.operational": reason },
      })
    );
    const page = await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) });
    render(page);
    expect(screen.getByText(/300 MW/)).toBeInTheDocument();
    expect(screen.getByText(/Operational: Not recorded — The 107 MW figure is company-wide/)).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it("keeps the operational fill prompt when only the planned capacity is marked", async () => {
    mockGetFacilityByIdCached.mockResolvedValue(
      makeFacility({
        status: "operational",
        notRecorded: { "capacityMw.planned": "No expansion capacity has been published." },
      })
    );
    const page = await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) });
    const { container } = render(page);
    // capacity + powered-by + announced: the operational field is NOT marked.
    expect(printNils(container)).toHaveLength(3);
    expect(screen.getByText(/Planned: Not recorded — No expansion capacity/)).toBeInTheDocument();
  });

  it("shows no fill prompt for the capacity field that is itself marked", async () => {
    mockGetFacilityByIdCached.mockResolvedValue(
      makeFacility({
        status: "operational",
        notRecorded: { "capacityMw.operational": "The 107 MW figure is company-wide, not this site." },
      })
    );
    const page = await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) });
    const { container } = render(page);
    // the marked capacity field prints its reason, not a nil: powered-by + announced only.
    expect(printNils(container)).toHaveLength(2);
    expect(screen.getByText(/Operational: Not recorded — The 107 MW figure/)).toBeInTheDocument();
  });

  it("renders two marked capacity fields with identical reasons without a duplicate-key warning", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reason = "No public filing states a capacity for this site.";
    mockGetFacilityByIdCached.mockResolvedValue(
      makeFacility({
        notRecorded: { "capacityMw.operational": reason, "capacityMw.planned": reason },
      })
    );
    const page = await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) });
    render(page);
    expect(screen.getAllByText(/Not recorded — No public filing/)).toHaveLength(2);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("renders the populated value with no prompt when capacity, powered-by, and announced date are all present", async () => {
    const facility = makeFacility({
      name: "Fullville Data Center",
      capacityMw: { operational: 150 },
      poweredBy: "Grid — Dominion Energy",
      announcedDate: "2025-03-01",
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const page = await FacilityPage({
      params: Promise.resolve({ slug: "test-facility" }),
    });
    const { container } = render(page);

    expect(screen.getByText("150 MW")).toBeInTheDocument();
    expect(screen.getByText("Grid — Dominion Energy")).toBeInTheDocument();
    expect(screen.getByText("2025-03-01")).toBeInTheDocument();

    expect(printNils(container)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Correction dialogs on the page: each shows the facility's current value, and
// the masthead Capacity row targets the capacity field that applies to the
// facility (planned for every status but operational) or that the page
// actually shows.
// ---------------------------------------------------------------------------

describe("FacilityPage — correction dialogs", () => {
  async function renderPage(facility: Facility) {
    mockGetFacilityByIdCached.mockResolvedValue(facility);
    const page = await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) });
    render(page);
  }

  it("gives the 'Spot an error?' dialog the facility's current values", async () => {
    const user = userEvent.setup();
    await renderPage(makeFacility({ name: "Colossus" }));

    await user.click(screen.getByRole("button", { name: /spot an error\?/i }));

    expect(screen.getByText("Currently: Colossus")).toBeInTheDocument();
  });

  it("gives the bottom 'Suggest a correction' dialog the facility's current values", async () => {
    const user = userEvent.setup();
    await renderPage(makeFacility({ name: "Colossus" }));

    await user.click(screen.getByRole("button", { name: /^suggest a correction$/i }));

    expect(screen.getByText("Currently: Colossus")).toBeInTheDocument();
  });

  it("'No' on a planned-only capacity corrects planned capacity, and shows its current value", async () => {
    const user = userEvent.setup();
    await renderPage(makeFacility({ status: "proposed", capacityMw: { planned: 1200 } }));

    expect(screen.getByText("1,200 MW planned")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No, the capacity needs a correction" }));

    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toHaveTextContent(
      "Planned capacity (MW)"
    );
    expect(screen.getByText("Currently: 1,200 MW")).toBeInTheDocument();
  });

  it("'No' on an operational capacity corrects operational capacity, and shows its current value", async () => {
    const user = userEvent.setup();
    await renderPage(makeFacility({ capacityMw: { operational: 150 } }));

    await user.click(screen.getByRole("button", { name: "No, the capacity needs a correction" }));

    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toHaveTextContent(
      "Operational capacity (MW)"
    );
    expect(screen.getByText("Currently: 150 MW")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Agent-quotable contribution note (SourceCorrectionNote) — plain,
// server-rendered prose distinct from the interactive SuggestCorrection CTA,
// so a retrieval agent or search snippet can quote the fact even though it
// can't click a button. See components/contribute/source-correction-note.tsx.
// ---------------------------------------------------------------------------

describe("FacilityPage — agent-quotable contribution note", () => {
  it("renders the source-cited/correctable sentence in server output, with a working /contribute link", async () => {
    const facility = makeFacility({ name: "Quotable Data Center" });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const page = await FacilityPage({
      params: Promise.resolve({ slug: "test-facility" }),
    });
    render(page);

    // Substring lives entirely in the text node BEFORE the embedded <Link>,
    // so it's safe against getByText's direct-text-node-only matching (it
    // would NOT see text split across the link boundary).
    expect(
      screen.getByText(/source-cited, publicly correctable dataset/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "compute-atlas.com/contribute" })
    ).toHaveAttribute("href", "/contribute");
  });
});

describe("FacilityPage — loader results reach the sections as props", () => {
  const SITING = { nearestWater: { name: "Fake River", kind: "river", distanceMi: 2 } };
  const OWNERSHIP = [{ operator: "Acme Corp", owners: [] }];

  it("passes the loaded siting to SitingContextSection and PrintGapSummary, and ownership to StakeholdersSection", async () => {
    const facility = makeFacility();
    mockGetFacilityByIdCached.mockResolvedValue(facility);
    mockGetSitingContext.mockResolvedValue(SITING);
    mockGetOperatorOwnership.mockResolvedValue(OWNERSHIP);
    stakeholdersProps.mockClear();
    sitingSectionProps.mockClear();
    printGapProps.mockClear();

    render(await FacilityPage({ params: Promise.resolve({ slug: facility.id }) }));

    expect(mockGetSitingContext).toHaveBeenCalledWith(facility.id);
    expect(mockGetOperatorOwnership).toHaveBeenCalledWith(facility.operator);
    expect(sitingSectionProps.mock.calls[0][0]).toMatchObject({ siting: SITING });
    expect(printGapProps.mock.calls[0][0]).toMatchObject({ siting: SITING });
    expect(stakeholdersProps.mock.calls[0][0]).toMatchObject({ ownership: OWNERSHIP });
  });
});

describe("FacilityPage — 'What this record is missing' card", () => {
  const ITEMS = [
    { field: "poweredBy", label: "who powers it" },
    { label: "air permit" },
  ];

  it("renders one card with one 'Send a source' button and no 'Send us a link' prompts", async () => {
    mockMissingRecordItems.mockReturnValue(ITEMS);
    mockGetFacilityByIdCached.mockResolvedValue(makeFacility());

    const { container } = render(await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) }));

    expect(screen.getByRole("heading", { level: 2, name: "What this record is missing" })).toBeInTheDocument();
    expect(container.textContent?.match(/Send a source/g)).toHaveLength(1);
    expect(container.textContent).not.toContain("Send us a link");
  });

  it("gets the page's facility, siting and ownership", async () => {
    const facility = makeFacility();
    mockGetFacilityByIdCached.mockResolvedValue(facility);
    mockGetSitingContext.mockResolvedValue(undefined);
    mockGetOperatorOwnership.mockResolvedValue([]);

    render(await FacilityPage({ params: Promise.resolve({ slug: facility.id }) }));

    expect(mockMissingRecordItems).toHaveBeenCalledWith(facility, undefined, true);
  });

  it("renders no card when nothing is missing", async () => {
    mockGetFacilityByIdCached.mockResolvedValue(makeFacility());

    render(await FacilityPage({ params: Promise.resolve({ slug: "test-facility" }) }));

    expect(screen.queryByRole("heading", { name: "What this record is missing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send a source/i })).not.toBeInTheDocument();
  });
});
