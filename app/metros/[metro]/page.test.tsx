import { vi, describe, it, expect, beforeEach } from "vitest";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetFacilitiesByMetro } = vi.hoisted(() => ({
  mockGetFacilitiesByMetro: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByMetro: mockGetFacilitiesByMetro,
}));

import { generateMetadata } from "./page";

beforeEach(() => {
  mockGetFacilitiesByMetro.mockReset();
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

describe("generateMetadata (metro)", () => {
  it("northern-virginia: title contains 'Northern Virginia'; description mentions the live count; canonical is /metros/northern-virginia", async () => {
    mockGetFacilitiesByMetro.mockResolvedValue([makeFacility(), makeFacility({ id: "two" })]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ metro: "northern-virginia" }),
    });

    expect(metadata.title).toBe("Data centers in Northern Virginia");
    expect(metadata.description).toContain("2 data centers");
    expect(metadata.description).toContain("Northern Virginia");
    expect(metadata.alternates).toEqual({ canonical: "/metros/northern-virginia" });
  });

  it("bay-area: title is 'Data centers in Bay Area & Silicon Valley'", async () => {
    mockGetFacilitiesByMetro.mockResolvedValue([makeFacility()]);

    const metadata = await generateMetadata({
      params: Promise.resolve({ metro: "bay-area" }),
    });

    expect(metadata.title).toBe("Data centers in Bay Area & Silicon Valley");
    expect(metadata.alternates).toEqual({ canonical: "/metros/bay-area" });
  });

  it("returns a not-found title for an unknown metro slug, without querying the data layer", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ metro: "bogus" }),
    });

    expect(metadata).toEqual({ title: "Metro not found" });
    expect(mockGetFacilitiesByMetro).not.toHaveBeenCalled();
  });
});
