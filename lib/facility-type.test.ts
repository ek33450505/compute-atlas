import { describe, it, expect } from "vitest";
import {
  FACILITY_TYPE_ORDER,
  FACILITY_TYPE_META,
  getFacilityTypeMeta,
} from "./facility-type";

describe("FACILITY_TYPE_ORDER", () => {
  it("has exactly 3 entries", () => {
    expect(FACILITY_TYPE_ORDER).toHaveLength(3);
  });

  it("contains all expected facility-type keys in schema declaration order", () => {
    expect(FACILITY_TYPE_ORDER).toEqual([
      "data_center",
      "crypto_mining",
      "power_generation",
    ]);
  });
});

describe("FACILITY_TYPE_META", () => {
  it("every facility type has a label", () => {
    for (const type of FACILITY_TYPE_ORDER) {
      expect(FACILITY_TYPE_META[type].label).toBeTruthy();
    }
  });

  it("uses the exact established wording", () => {
    expect(FACILITY_TYPE_META.data_center.label).toBe("Data center");
    expect(FACILITY_TYPE_META.crypto_mining.label).toBe("Crypto mining");
    expect(FACILITY_TYPE_META.power_generation.label).toBe("Power generation");
  });
});

describe("getFacilityTypeMeta", () => {
  it("returns the correct meta for data_center", () => {
    expect(getFacilityTypeMeta("data_center").label).toBe("Data center");
  });

  it("returns the correct meta for crypto_mining", () => {
    expect(getFacilityTypeMeta("crypto_mining").label).toBe("Crypto mining");
  });

  it("returns the correct meta for power_generation", () => {
    expect(getFacilityTypeMeta("power_generation").label).toBe(
      "Power generation"
    );
  });
});
