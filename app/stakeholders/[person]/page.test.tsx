import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { DataCenterFacility } from "@/lib/schema";
import type { StakeholderSummary } from "@/lib/data";

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
    roles: ["founder"],
    facilityCount: 1,
    states: ["IL"],
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

describe("generateMetadata (stakeholder)", () => {
  it("returns a not-found title for an unknown slug, without querying facilities", async () => {
    mockGetStakeholderBySlug.mockResolvedValue(undefined);

    const metadata = await generateMetadata({
      params: Promise.resolve({ person: "not-a-real-person" }),
    });

    expect(metadata).toEqual({ title: "Stakeholder not found" });
    expect(mockGetFacilitiesByStakeholder).not.toHaveBeenCalled();
  });

  it("titles a known slug with the person's name and sets the canonical", async () => {
    mockGetStakeholderBySlug.mockResolvedValue("Jane Doe");
    mockGetFacilitiesByStakeholder.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ person: "jane-doe" }),
    });

    expect(metadata.title).toBe("Jane Doe — facilities");
    expect(metadata.alternates).toEqual({ canonical: "/stakeholders/jane-doe" });
  });
});
