import { describe, it, expect } from "vitest";
import { getGridCarbonIntensityGCo2PerKwh } from "./egrid";

describe("getGridCarbonIntensityGCo2PerKwh", () => {
  it("returns the eGRID-derived intensity for TX (ERCOT)", () => {
    const result = getGridCarbonIntensityGCo2PerKwh("TX");
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(332.9, 0);
  });

  it("returns null for a state not in the confident-assignment table", () => {
    expect(getGridCarbonIntensityGCo2PerKwh("WY")).toBeNull();
  });
});
