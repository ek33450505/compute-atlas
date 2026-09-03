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

import { generateMetadata } from "./page";

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
    });

    expect(metadata.title).toBe("Proposed data centers in the US");
    expect(metadata.description).toContain("2 proposed data center");
    expect(metadata.alternates).toEqual({ canonical: "/status/proposed" });
  });

  it("under_construction: title is 'Data centers under construction in the US'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "under_construction" }),
    });

    expect(metadata.title).toBe("Data centers under construction in the US");
    expect(metadata.description).toContain("1 data center currently under construction");
  });

  it("operational: title is 'Operational data centers in the US'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "operational" }),
    });

    expect(metadata.title).toBe("Operational data centers in the US");
    expect(metadata.alternates).toEqual({ canonical: "/status/operational" });
  });

  it("permitted: title is 'Permitted data centers in the US'", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "permitted" }),
    });

    expect(metadata.title).toBe("Permitted data centers in the US");
  });

  it("cancelled: title is 'Cancelled data center projects'; handles a zero count", async () => {
    mockGetFacilitiesByStatus.mockResolvedValue([]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "cancelled" }),
    });

    expect(metadata.title).toBe("Cancelled data center projects");
    expect(metadata.description).toContain("0 cancelled or withdrawn data center projects");
  });

  it("returns a not-found title for an invalid status param, without querying the data layer", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ status: "bogus" }),
    });

    expect(metadata).toEqual({ title: "Status not found" });
    expect(mockGetFacilitiesByStatus).not.toHaveBeenCalled();
  });
});
