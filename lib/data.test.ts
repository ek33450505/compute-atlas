import { describe, it, expect } from "vitest";
import {
  getAllFacilities,
  getFacilityById,
  getStates,
  getOperators,
  getStatusCounts,
} from "@/lib/data";
import { facilitySchema } from "@/lib/schema";

describe("getAllFacilities", () => {
  it("returns a non-empty array including known seed ids", () => {
    const facilities = getAllFacilities();
    expect(facilities.length).toBeGreaterThanOrEqual(20);
    const ids = facilities.map((f) => f.id);
    expect(ids).toContain("meta-prineville-or");
    expect(ids).toContain("xai-colossus-memphis-tn");
  });

  it("each facility conforms to facilitySchema", () => {
    for (const f of getAllFacilities()) {
      const result = facilitySchema.safeParse(f);
      expect(result.success).toBe(true);
    }
  });
});

describe("getFacilityById", () => {
  it("returns the correct facility for a known id", () => {
    const facility = getFacilityById("meta-prineville-or");
    expect(facility).toBeDefined();
    expect(facility?.id).toBe("meta-prineville-or");
    expect(facility?.operator).toBe("Meta");
  });

  it("returns undefined for an unknown id", () => {
    expect(getFacilityById("not-a-real-facility")).toBeUndefined();
  });
});

describe("getStates", () => {
  it("returns unique state codes", () => {
    const states = getStates();
    expect(states).toEqual([...new Set(states)]);
  });

  it("returns states sorted A→Z", () => {
    const states = getStates();
    expect(states).toEqual([...states].sort());
  });

  it("each entry is exactly 2 characters", () => {
    getStates().forEach((s) => expect(s).toHaveLength(2));
  });
});

describe("getOperators", () => {
  it("returns unique operators", () => {
    const operators = getOperators();
    expect(operators).toEqual([...new Set(operators)]);
  });

  it("returns operators sorted A→Z", () => {
    const operators = getOperators();
    expect(operators).toEqual([...operators].sort());
  });
});

describe("getStatusCounts", () => {
  it("totals match the full facility count", () => {
    const counts = getStatusCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(getAllFacilities().length);
  });
});
