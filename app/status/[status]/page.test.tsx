import { vi, describe, it, expect, beforeEach } from "vitest";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetFacilitiesByStatus } = vi.hoisted(() => ({
  mockGetFacilitiesByStatus: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByStatus: mockGetFacilitiesByStatus,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (CollectionPage's facility cards render Link internally).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    "aria-current"?: "page";
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));

import { render, screen, within } from "@testing-library/react";
import StatusPage, { generateMetadata } from "./page";

const NO_PARAMS = Promise.resolve({});

beforeEach(() => {
  mockGetFacilitiesByStatus.mockReset();
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

describe("generateMetadata (status)", () => {
  it("proposed: title is 'Proposed data centers in the US'; description mentions the live count", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([makeFacility(), makeFacility({ id: "two" })]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "proposed" }),
      searchParams: NO_PARAMS,
    });

    expect(metadata.title).toBe("Proposed data centers in the US");
    expect(metadata.description).toContain("2 proposed data center");
    expect(metadata.alternates).toEqual({ canonical: "/status/proposed" });
  });

  it("under_construction: title is 'Data centers under construction in the US'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "under_construction" }),
      searchParams: NO_PARAMS,
    });

    expect(metadata.title).toBe("Data centers under construction in the US");
    expect(metadata.description).toContain("1 data center currently under construction");
  });

  it("operational: title is 'Operational data centers in the US'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "operational" }),
      searchParams: NO_PARAMS,
    });

    expect(metadata.title).toBe("Operational data centers in the US");
    expect(metadata.alternates).toEqual({ canonical: "/status/operational" });
  });

  it("permitted: title is 'Permitted data centers in the US'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "permitted" }),
      searchParams: NO_PARAMS,
    });

    expect(metadata.title).toBe("Permitted data centers in the US");
  });

  it("cancelled: title is 'Cancelled data center projects'; handles a zero count", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "cancelled" }),
      searchParams: NO_PARAMS,
    });

    expect(metadata.title).toBe("Cancelled data center projects");
    expect(metadata.description).toContain("0 cancelled or withdrawn data center projects");
  });

  it("returns a not-found title for an invalid status param, without querying the data layer", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "bogus" }),
      searchParams: NO_PARAMS,
    });

    expect(metadata).toEqual({ title: "Status not found" });
    expect(mockGetFacilitiesByStatus).not.toHaveBeenCalled();
  });
});

describe("StatusPage — DC-aware fact line", () => {
  it("phrases the fact line as '1 state and DC' when the status's facilities span only VA and DC", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([
      makeFacility({ id: "a", location: { lat: 38, lon: -77, state: "VA", precision: "exact" } }),
      makeFacility({ id: "b", location: { lat: 38.9, lon: -77, state: "DC", precision: "exact" } }),
    ]);

    const page = await StatusPage({ params: Promise.resolve({ status: "proposed" }), searchParams: NO_PARAMS });
    render(page);

    // Mutation coverage: reverting to the bare `${stateCount} state(s)`
    // template (dropping containsDc/statesPhrase) renders "2 states" instead.
    expect(screen.getByText(/spanning 1 state and DC\./)).toBeInTheDocument();
    expect(screen.queryByText(/spanning 2 states\./)).not.toBeInTheDocument();
  });

  it("phrases the fact line as a bare state count when no facility is in DC", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([
      makeFacility({ id: "a", location: { lat: 38, lon: -77, state: "VA", precision: "exact" } }),
      makeFacility({ id: "b", location: { lat: 40, lon: -90, state: "IL", precision: "exact" } }),
    ]);

    const page = await StatusPage({ params: Promise.resolve({ status: "proposed" }), searchParams: NO_PARAMS });
    render(page);

    expect(screen.getByText(/spanning 2 states\./)).toBeInTheDocument();
  });
});

/**
 * The stat-row tile for a label. Scoped to the label span (uppercase,
 * wide-tracked) so a bare figure that also appears on a facility card or in
 * the intro prose cannot satisfy the assertion by accident.
 */
function statTile(label: string): HTMLElement {
  const matches = screen
    .getAllByText(label)
    .filter((el) => el.tagName === "SPAN" && el.classList.contains("tracking-widest"));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one stat tile labeled "${label}", found ${matches.length}`);
  }
  const tile = matches[0].closest("div");
  if (!tile) throw new Error(`no tile wrapping label "${label}"`);
  return tile;
}

describe("StatusPage — capacity stat", () => {
  const FACILITIES = [
    makeFacility({ id: "a", capacityMw: { operational: 600, planned: 100 } }),
    makeFacility({ id: "b", capacityMw: { operational: 900, planned: 1500 } }),
    makeFacility({ id: "c" }),
  ];

  it("operational: shows the summed operational capacity under 'Operational capacity'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(FACILITIES);

    render(await StatusPage({ params: Promise.resolve({ status: "operational" }), searchParams: NO_PARAMS }));

    expect(within(statTile("Sites")).getByText("3")).toBeInTheDocument();
    expect(within(statTile("Operational capacity")).getByText("1.5 GW")).toBeInTheDocument();
  });

  it("proposed: shows the summed planned capacity under 'Planned capacity'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(FACILITIES);

    render(await StatusPage({ params: Promise.resolve({ status: "proposed" }), searchParams: NO_PARAMS }));

    expect(within(statTile("Planned capacity")).getByText("1.6 GW")).toBeInTheDocument();
  });

  it("cancelled: shows the summed planned capacity under the cancelled label", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(FACILITIES);

    render(await StatusPage({ params: Promise.resolve({ status: "cancelled" }), searchParams: NO_PARAMS }));

    expect(
      within(statTile("Planned capacity (cancelled)")).getByText("1.6 GW")
    ).toBeInTheDocument();
  });
});

describe("StatusPage — by-state paging", () => {
  const params = Promise.resolve({ status: "operational" });
  const inState = (n: number, state: string, prefix: string) =>
    Array.from({ length: n }, (_, i) =>
      makeFacility({
        id: `${prefix}-${i}`,
        name: `${prefix} Site ${i}`,
        status: "operational",
        location: { lat: 38, lon: -77, state, precision: "exact" },
      })
    );
  // 60 IL + 5 VA: more than TOP_SHOWN in total.
  const MANY = [...inState(60, "IL", "Illinois"), ...inState(5, "VA", "Virginia")];

  // ShowMoreList keeps collapsed cards in the DOM behind `hidden`, so count
  // with hidden:true to measure what actually ships in the HTML.
  const shipped = (name: RegExp) => screen.getAllByRole("link", { name, hidden: true });

  it("default view renders at most 48 cards while the stat row shows the full count", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(MANY);

    render(await StatusPage({ params, searchParams: NO_PARAMS }));

    expect(shipped(/Site \d+/)).toHaveLength(48);
    expect(within(statTile("Sites")).getByText("65")).toBeInTheDocument();
    expect(screen.getByText(/Showing 48 of 65, largest disclosed capacity first/)).toBeInTheDocument();
  });

  it("?state=va renders every VA facility and no others", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(MANY);

    render(await StatusPage({ params, searchParams: Promise.resolve({ state: "va" }) }));

    expect(shipped(/Virginia Site \d+/)).toHaveLength(5);
    expect(screen.queryByRole("link", { name: /Illinois Site/, hidden: true })).not.toBeInTheDocument();
    expect(within(statTile("Sites")).getByText("5")).toBeInTheDocument();
    expect(screen.getByText(/5 operational facilities in Virginia\./)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Operational data centers in Virginia" })
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Operational facilities by state" });
    expect(within(nav).getByRole("link", { name: /Virginia/ })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(within(nav).getByRole("link", { name: /Illinois/ })).not.toHaveAttribute(
      "aria-current"
    );
  });

  it("?state=il is not capped at 48", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(MANY);

    render(await StatusPage({ params, searchParams: Promise.resolve({ state: "il" }) }));

    expect(shipped(/Illinois Site \d+/)).toHaveLength(60);
  });

  it("an unknown ?state=zz falls back to the default view", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(MANY);

    render(await StatusPage({ params, searchParams: Promise.resolve({ state: "zz" }) }));

    expect(shipped(/Site \d+/)).toHaveLength(48);
    expect(within(statTile("Sites")).getByText("65")).toBeInTheDocument();
  });

  it("the state nav links to ?state=xx under the status path", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(MANY);

    render(await StatusPage({ params, searchParams: NO_PARAMS }));

    const nav = screen.getByRole("navigation", { name: "Operational facilities by state" });
    expect(within(nav).getByRole("link", { name: /Virginia/ })).toHaveAttribute(
      "href",
      "/status/operational?state=va"
    );
  });

  it("state view breadcrumb links back to the status page", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(MANY);

    render(await StatusPage({ params, searchParams: Promise.resolve({ state: "va" }) }));

    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Operational" })).toHaveAttribute(
      "href",
      "/status/operational"
    );
    expect(within(crumbs).getByText("Virginia")).toBeInTheDocument();
  });

  it("metadata canonical: default, state, and invalid-state views", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue(MANY);
    const meta = (sp: Record<string, string>) =>
      generateMetadata({ params, searchParams: Promise.resolve(sp) });

    expect((await meta({})).alternates).toEqual({ canonical: "/status/operational" });
    const va = await meta({ state: "va" });
    expect(va.alternates).toEqual({ canonical: "/status/operational?state=va" });
    expect(va.title).toBe("Operational data centers in Virginia");
    expect(va.description).toContain("5 operational data centers");
    expect((await meta({ state: "zz" })).alternates).toEqual({
      canonical: "/status/operational",
    });
  });
});
