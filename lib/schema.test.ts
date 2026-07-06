import { describe, it, expect } from "vitest";
import { facilitySchema } from "@/lib/schema";

const baseSource = {
  url: "https://en.wikipedia.org/wiki/Test",
  label: "Test Source",
  retrievedAt: "2026-07-05",
  kind: "press" as const,
};

const baseFacility = {
  id: "test-facility",
  name: "Test Facility",
  operator: "Test Operator",
  status: "operational" as const,
  aiClassification: "confirmed" as const,
  confidence: "reported" as const,
  location: {
    lat: 35.0,
    lon: -90.0,
    state: "TN",
  },
  sources: [baseSource],
  lastUpdated: "2026-07-05",
};

describe("facilitySchema — happy path", () => {
  it("parses a valid facility", () => {
    const result = facilitySchema.safeParse(baseFacility);
    expect(result.success).toBe(true);
  });

  it("defaults statusHistory to [] when omitted", () => {
    const result = facilitySchema.safeParse(baseFacility);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.statusHistory).toEqual([]);
    }
  });
});

describe("facilitySchema — invalid cases", () => {
  it("fails when state is not 2 characters", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      location: { ...baseFacility.location, state: "TNN" },
    });
    expect(result.success).toBe(false);
  });

  it("fails when sources array is empty", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      sources: [],
    });
    expect(result.success).toBe(false);
  });

  it("fails when lat is out of range (> 90)", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      location: { ...baseFacility.location, lat: 91 },
    });
    expect(result.success).toBe(false);
  });

  it("fails when id contains uppercase letters or spaces", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      id: "Test Facility!",
    });
    expect(result.success).toBe(false);
  });

  it("fails when statusHistory sourceIndex is out of range of sources", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      statusHistory: [
        { status: "operational", date: "2024", sourceIndex: 5 },
      ],
    });
    expect(result.success).toBe(false);
  });
});
