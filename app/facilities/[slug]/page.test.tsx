import { vi, describe, it, expect } from "vitest";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetFacilityByIdCached } = vi.hoisted(() => ({
  mockGetFacilityByIdCached: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilityByIdCached: mockGetFacilityByIdCached,
  getAllFacilityIds: vi.fn(),
}));

import { generateMetadata } from "./page";

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
    const facility = makeFacility({
      name: "Sunrise Solar Array",
      operator: "NextEra Energy",
      facilityType: "power_generation",
      location: { lat: 32.7, lon: -97.3, city: "Fort Worth", state: "TX", precision: "exact" },
    });
    mockGetFacilityByIdCached.mockResolvedValue(facility);

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "sunrise-solar-array" }),
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
});
