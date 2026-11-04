import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { DataCenterFacility } from "@/lib/schema";
import type { StakeholderSummary, ViaOperator } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const { mockGetStakeholderBySlug, mockGetFacilitiesByStakeholder, mockGetStakeholders } =
  vi.hoisted(() => ({
    mockGetStakeholderBySlug: vi.fn(),
    mockGetFacilitiesByStakeholder: vi.fn(),
    mockGetStakeholders: vi.fn(),
  }));

vi.mock("@/lib/data", () => ({
  getStakeholderBySlug: mockGetStakeholderBySlug,
  getFacilitiesByStakeholder: mockGetFacilitiesByStakeholder,
  getStakeholders: mockGetStakeholders,
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

import StakeholderPage, { generateMetadata } from "./page";

function makeFacility(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2026-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<StakeholderSummary> = {}): StakeholderSummary {
  return {
    name: "Jane Doe",
    slug: "jane-doe",
    kind: "person",
    roles: ["founder"],
    facilityCount: 1,
    operatorFacilityCount: 0,
    viaOperators: [],
    states: ["IL"],
    ...overrides,
  };
}

function makeVia(overrides: Partial<ViaOperator> = {}): ViaOperator {
  return {
    operator: "Acme Corp",
    slug: "acme-corp",
    facilityCount: 3,
    owner: {
      name: "Example Capital",
      kind: "organization",
      role: "controlling_owner",
      note: "Owns the operating company.",
      source: {
        url: "https://example.com/own",
        label: "Ownership filing",
        retrievedAt: "2026-11-04",
        kind: "filing",
      },
      asOf: "2026-11-04",
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockGetStakeholderBySlug.mockReset();
  mockGetFacilitiesByStakeholder.mockReset();
  mockGetStakeholders.mockReset();
});

describe("StakeholderPage", () => {
  it("calls notFound (throws) for an unknown slug, without fetching facilities", async () => {
    mockGetStakeholderBySlug.mockResolvedValue(undefined);

    await expect(
      StakeholderPage({ params: Promise.resolve({ person: "not-a-real-person" }) })
    ).rejects.toThrow();

    expect(mockGetFacilitiesByStakeholder).not.toHaveBeenCalled();
  });

  it("renders the person's name as the page heading for a known slug", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([makeFacility()]);
    mockGetStakeholders.mockResolvedValue([makeSummary()]);

    const page = await StakeholderPage({ params: Promise.resolve({ person: "jane-doe" }) });
    render(page);

    expect(screen.getByRole("heading", { level: 1, name: "Jane Doe" })).toBeInTheDocument();
  });

  it("marks the states stat and footnotes DC, showing the state count (1), not the raw jurisdiction total (2), when the person's facilities span DC", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([
      makeFacility({ id: "a" }),
      makeFacility({ id: "b" }),
    ]);
    mockGetStakeholders.mockResolvedValue([
      makeSummary({ states: ["DC", "VA"] }),
    ]);

    const page = await StakeholderPage({ params: Promise.resolve({ person: "jane-doe" }) });
    render(page);

    // The bug this guards: the tile's rendered VALUE must be the state count
    // (1: just VA), not the raw jurisdiction total (2: VA + DC) — "2 / States"
    // over a footnote naming DC reads as "two states, plus DC." The
    // "Facilities" tile legitimately also renders "2" here (2 facilities), so
    // the negative check below is scoped to the states tile rather than a
    // page-wide queryByText("2"). Reverting the call site to pass the raw
    // total back to `value` fails the scoped "2" negative; dropping statesStat
    // entirely leaves the caption unmarked and prints no footnote.
    const statesTile = screen.getByText("State").closest("div");
    expect(statesTile).not.toBeNull();
    expect(within(statesTile!).getByText("1")).toBeInTheDocument();
    expect(within(statesTile!).queryByText("2")).not.toBeInTheDocument();
    expect(within(statesTile!).getByText("*")).toBeInTheDocument();
    expect(screen.getByText("Plus the District of Columbia")).toBeInTheDocument();
  });

  it("labels the states stat plain 'States' when no DC facility is present", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([
      makeFacility({ id: "a" }),
      makeFacility({ id: "b" }),
    ]);
    mockGetStakeholders.mockResolvedValue([makeSummary({ states: ["IL", "TX"] })]);

    const page = await StakeholderPage({ params: Promise.resolve({ person: "jane-doe" }) });
    render(page);

    expect(screen.getByText("States")).toBeInTheDocument();
  });
});

describe("StakeholderPage — operator-level owner", () => {
  const ownerSummary = makeSummary({
    name: "Example Capital",
    slug: "example-capital",
    kind: "organization",
    roles: ["controlling_owner"],
    facilityCount: 0,
    operatorFacilityCount: 3,
    viaOperators: [makeVia(), makeVia({ operator: "Ghost Operator", slug: "ghost-operator", facilityCount: 0 })],
    states: [],
  });

  it("shows an Operators tile and no States or Facilities tile for an owner with no site-level facility", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Example Capital");
    mockGetFacilitiesByStakeholder.mockResolvedValue([]);
    mockGetStakeholders.mockResolvedValue([ownerSummary]);

    render(await StakeholderPage({ params: Promise.resolve({ person: "example-capital" }) }));

    expect(screen.getByText("Operators")).toBeInTheDocument();
    expect(screen.queryByText("States")).not.toBeInTheDocument();
    expect(screen.queryByText("State")).not.toBeInTheDocument();
    expect(screen.queryByText("Facilities")).not.toBeInTheDocument();
  });

  it("renders both the card grid and the ownership section for a name with site-level and operator stakes", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([makeFacility()]);
    mockGetStakeholders.mockResolvedValue([makeSummary({ viaOperators: [makeVia()], operatorFacilityCount: 3 })]);

    render(await StakeholderPage({ params: Promise.resolve({ person: "jane-doe" }) }));

    expect(screen.getByText("Facilities")).toBeInTheDocument();
    expect(screen.getByText("Operators")).toBeInTheDocument();
    expect(screen.getByText("State")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Through operator ownership" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Test Facility/ })).toBeInTheDocument();
  });

  it("renders (does not 404) for an owner with no site-level facility, and never says 'tracks 0 facilities'", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Example Capital");
    mockGetFacilitiesByStakeholder.mockResolvedValue([]);
    mockGetStakeholders.mockResolvedValue([ownerSummary]);

    const page = await StakeholderPage({ params: Promise.resolve({ person: "example-capital" }) });
    render(page);

    expect(screen.getByRole("heading", { level: 1, name: "Example Capital" })).toBeInTheDocument();
    expect(screen.queryByText(/tracks 0 facilit/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no stake documented for a specific site/i)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp and Ghost Operator/)).toBeInTheDocument();
  });

  it("lists each operator under 'Through operator ownership', linking only operators that have a page", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Example Capital");
    mockGetFacilitiesByStakeholder.mockResolvedValue([]);
    mockGetStakeholders.mockResolvedValue([ownerSummary]);

    const page = await StakeholderPage({ params: Promise.resolve({ person: "example-capital" }) });
    render(page);

    const heading = screen.getByRole("heading", { name: "Through operator ownership" });
    const section = heading.closest("section") as HTMLElement;
    const link = within(section).getByRole("link", { name: "Acme Corp" });
    expect(link).toHaveAttribute("href", "/operators/acme-corp");
    expect(within(section).queryByRole("link", { name: "Ghost Operator" })).not.toBeInTheDocument();
    expect(within(section).getByText("· Controlling owner · 3 tracked facilities", { exact: false })).toBeInTheDocument();
    expect(within(section).getByText("· Controlling owner · 0 tracked facilities", { exact: false })).toBeInTheDocument();
    const sourceLinks = within(section).getAllByRole("link", { name: /Ownership filing \(opens in new tab\)/ });
    expect(sourceLinks).toHaveLength(2);
    expect(sourceLinks[0]).toHaveAttribute("href", "https://example.com/own");
  });

  it("omits the ownership section when the person owns no operator stake", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([makeFacility()]);
    mockGetStakeholders.mockResolvedValue([makeSummary()]);

    const page = await StakeholderPage({ params: Promise.resolve({ person: "jane-doe" }) });
    render(page);

    expect(screen.queryByRole("heading", { name: "Through operator ownership" })).not.toBeInTheDocument();
    expect(screen.getByText(/Compute Atlas tracks 1 facility/)).toBeInTheDocument();
  });

  it("still calls notFound for a known name with neither site-level facilities nor operator stakes", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([]);
    mockGetStakeholders.mockResolvedValue([makeSummary({ facilityCount: 0 })]);

    await expect(
      StakeholderPage({ params: Promise.resolve({ person: "jane-doe" }) })
    ).rejects.toThrow();
  });
});

describe("generateMetadata (stakeholder)", () => {
  it("returns a not-found title for an unknown slug, without querying facilities", async () => {
    mockGetStakeholderBySlug.mockResolvedValue(undefined);

    const metadata = await generateMetadata({
      params: Promise.resolve({ person: "not-a-real-person" }),
    });

    expect(metadata).toEqual({ title: "Stakeholder not found" });
    expect(mockGetFacilitiesByStakeholder).not.toHaveBeenCalled();
  });

  it("describes an owner with no site-level facility by its operator stake, not '0 facilities'", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Example Capital");
    mockGetFacilitiesByStakeholder.mockResolvedValue([]);
    mockGetStakeholders.mockResolvedValue([
      makeSummary({ name: "Example Capital", slug: "example-capital", facilityCount: 0, viaOperators: [makeVia()] }),
    ]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ person: "example-capital" }),
    });

    expect(metadata.description).toContain("stake in the operating company of 1 tracked operator");
    expect(metadata.description).not.toMatch(/^0 /);
  });

  it("titles a known slug with the person's name and sets the canonical", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([makeFacility()]);
    mockGetStakeholders.mockResolvedValue([makeSummary()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ person: "jane-doe" }),
    });

    expect(metadata.title).toBe("Jane Doe — stakeholder profile");
    expect(metadata.alternates).toEqual({ canonical: "/stakeholders/jane-doe" });
  });
});
