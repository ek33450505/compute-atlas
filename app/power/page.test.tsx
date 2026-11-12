import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type {
  GenerationStats,
  GenerationBuildoutStats,
  OfftakerGroup,
} from "@/lib/data";
import type { Facility, PowerGenerationFacility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const {
  mockGetPowerGenerationFacilities,
  mockGetGenerationByOfftaker,
  mockGetGenerationStats,
  mockGetGenerationBuildoutStats,
  mockGetEnergySourceCounts,
  mockGetFacilitiesByWaterUsage,
  mockGetCoolingTypeCounts,
} = vi.hoisted(() => ({
  mockGetPowerGenerationFacilities: vi.fn(),
  mockGetGenerationByOfftaker: vi.fn(),
  mockGetGenerationStats: vi.fn(),
  mockGetGenerationBuildoutStats: vi.fn(),
  mockGetEnergySourceCounts: vi.fn(),
  mockGetFacilitiesByWaterUsage: vi.fn(),
  mockGetCoolingTypeCounts: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getPowerGenerationFacilities: mockGetPowerGenerationFacilities,
  getGenerationByOfftaker: mockGetGenerationByOfftaker,
  getGenerationStats: mockGetGenerationStats,
  getGenerationBuildoutStats: mockGetGenerationBuildoutStats,
  getEnergySourceCounts: mockGetEnergySourceCounts,
  getFacilitiesByWaterUsage: mockGetFacilitiesByWaterUsage,
  getCoolingTypeCounts: mockGetCoolingTypeCounts,
}));

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

import PowerPage from "./page";

function makeGenerationFacility(
  overrides: Partial<PowerGenerationFacility> = {},
): PowerGenerationFacility {
  return {
    id: "gen-one",
    name: "Gen One Plant",
    operator: "Acme Power",
    status: "operational",
    confidence: "confirmed",
    facilityType: "power_generation",
    location: {
      lat: 40,
      lon: -90,
      city: "Springfield",
      state: "IL",
      precision: "exact",
    },
    capacityMw: { operational: 100 },
    generation: { technology: "natural_gas", offtaker: "Acme Corp" },
    sources: [],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as PowerGenerationFacility;
}

function makeStats(overrides: Partial<GenerationStats> = {}): GenerationStats {
  return { count: 3, operationalMw: 500, plannedMw: 1200, offtakerCount: 2, ...overrides };
}

function makeBuildout(
  overrides: Partial<GenerationBuildoutStats> = {},
): GenerationBuildoutStats {
  return {
    fossilPlannedMw: 900,
    nonFossilPlannedMw: 300,
    fossilPlants: 2,
    nonFossilPlants: 1,
    gas: { total: 2, operational: 1, proposed: 1, permitted: 0, underConstruction: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  const facility = makeGenerationFacility();
  const offtakerGroup: OfftakerGroup = {
    offtaker: "Acme Corp",
    facilities: [facility],
    totalMw: 100,
  };
  mockGetPowerGenerationFacilities.mockResolvedValue([facility]);
  mockGetGenerationByOfftaker.mockResolvedValue([offtakerGroup]);
  mockGetGenerationStats.mockResolvedValue(makeStats());
  mockGetGenerationBuildoutStats.mockResolvedValue(makeBuildout());
  mockGetEnergySourceCounts.mockResolvedValue({
    on_site_gas: 2,
    grid: 1,
    nuclear: 0,
    solar: 0,
    wind: 0,
    hydro: 0,
    mixed: 0,
  });
  mockGetFacilitiesByWaterUsage.mockResolvedValue([] as Facility[]);
  mockGetCoolingTypeCounts.mockResolvedValue({
    closed_loop: 1,
    evaporative: 0,
    air_cooled: 0,
    once_through: 0,
    immersion: 0,
    unknown: 0,
  });
});

describe("PowerPage", () => {
  it("renders the masthead and the four survey stat tiles", async () => {
    render(await PowerPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /Behind-the-meter power generation for AI data centers/,
      }),
    ).toBeInTheDocument();

    // Scoped to the row, not the page: "Operational" legitimately appears
    // twice — once as this tile's caption and once in the gas status
    // breakdown below. A page-wide getByText would throw on the ambiguity,
    // and relaxing it to getAllByText would stop proving the caption is in
    // the stat row at all.
    const statRow = screen.getByText("Projects").closest("div")!.parentElement!;
    for (const label of ["Projects", "Operational", "Pipeline", "Offtakers"]) {
      expect(within(statRow).getByText(label)).toBeInTheDocument();
    }
  });

  it("pairs each headline figure with its own caption, not a neighbour's", async () => {
    // The bug class this guards is the one that shipped as "51 / States + DC":
    // a tile whose number and caption drift apart. Scope each assertion to the
    // tile rather than the page.
    render(await PowerPage({ searchParams: Promise.resolve({}) }));

    const projectsTile = screen.getByText("Projects").closest("div")!;
    expect(within(projectsTile).getByText("3")).toBeInTheDocument();

    const offtakersTile = screen.getByText("Offtakers").closest("div")!;
    expect(within(offtakersTile).getByText("2")).toBeInTheDocument();
  });

  it("renders the buildout, offtaker, technology and projects sections", async () => {
    render(await PowerPage({ searchParams: Promise.resolve({}) }));

    for (const name of [
      /What's being built/,
      /Who's buying the power/,
      /Technology mix/,
      /^Largest (project|\d+ projects)$/,
    ]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
  });

  it("names the offtaker a project sells its power to", async () => {
    render(await PowerPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getAllByText(/Acme Corp/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Gen One Plant/).length).toBeGreaterThan(0);
  });

  it("renders the empty state, and none of the stat sections, when nothing is tracked", async () => {
    // `stats.count === 0` takes a separate early-return branch that renders a
    // masthead and nothing else. Without this the branch is unexecuted code.
    mockGetGenerationStats.mockResolvedValue(makeStats({ count: 0 }));
    mockGetPowerGenerationFacilities.mockResolvedValue([]);
    mockGetGenerationByOfftaker.mockResolvedValue([]);

    render(await PowerPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByText(/No dedicated-generation projects are tracked yet\./),
    ).toBeInTheDocument();
    // The stat row must be absent, not merely zeroed — this is what fails if
    // the early return is deleted and the page falls through to the full body.
    expect(screen.queryByText("Offtakers")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Largest (project|\d+ projects)$/ })).not.toBeInTheDocument();
  });

  it("renders a ratio placeholder rather than Infinity when nothing non-fossil is planned", async () => {
    // formatRatio's divide-by-zero guard: the page must never print Infinity
    // or NaN at a reader.
    mockGetGenerationBuildoutStats.mockResolvedValue(
      makeBuildout({ nonFossilPlannedMw: 0 }),
    );

    const { container } = render(await PowerPage({ searchParams: Promise.resolve({}) }));

    expect(container.textContent).not.toMatch(/Infinity|NaN/);
  });
});

describe("PowerPage — by-state sub-views", () => {
  const il = makeGenerationFacility({ id: "il-1", name: "Illinois Plant" });
  const tx = makeGenerationFacility({
    id: "tx-1",
    name: "Texas Plant",
    location: { lat: 31, lon: -97, city: "Waco", state: "TX", precision: "exact" },
    generation: { technology: "nuclear" },
  });

  beforeEach(() => {
    mockGetPowerGenerationFacilities.mockResolvedValue([il, tx]);
  });

  it("links every state that holds a project and lists the largest projects on the default view", async () => {
    render(await PowerPage({ searchParams: Promise.resolve({}) }));

    const nav = screen.getByRole("navigation", { name: "Power projects by state" });
    expect(within(nav).getByRole("link", { name: /Illinois/ })).toHaveAttribute(
      "href",
      "/power?state=il",
    );
    expect(within(nav).getByRole("link", { name: /Texas/ })).toHaveAttribute(
      "href",
      "/power?state=tx",
    );
    // The offtaker section is a summary line per offtaker, not a row per project.
    expect(screen.getAllByRole("link", { name: /Illinois Plant/ })).toHaveLength(1);
  });

  it("lists only the selected state's projects, with their offtaker, and marks it current", async () => {
    render(await PowerPage({ searchParams: Promise.resolve({ state: "il" }) }));

    expect(screen.getByRole("link", { name: /Illinois Plant/ })).toHaveAttribute(
      "href",
      "/facilities/il-1",
    );
    expect(screen.queryByRole("link", { name: /Texas Plant/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Power projects by state" });
    expect(within(nav).getByRole("link", { name: /Illinois/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("heading", { name: "What's being built" })).not.toBeInTheDocument();
  });

  it.each(["zz", "ca", "%00", ["il", "tx"], ""])(
    "falls back to the default view for an invalid state (%j)",
    async (value) => {
      render(await PowerPage({ searchParams: Promise.resolve({ state: value }) }));

      expect(screen.getByRole("heading", { name: "What's being built" })).toBeInTheDocument();
    },
  );
});
