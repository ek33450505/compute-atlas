import { describe, it, expect } from "vitest";
import {
  FACILITY_TYPE_ORDER,
  FACILITY_TYPE_META,
  getFacilityTypeMeta,
} from "./facility-type";

describe("FACILITY_TYPE_ORDER", () => {
  it("has exactly 2 entries", () => {
    expect(FACILITY_TYPE_ORDER).toHaveLength(2);
  });

  it("contains all expected facility-type keys in schema declaration order", () => {
    expect(FACILITY_TYPE_ORDER).toEqual(["data_center", "crypto_mining"]);
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
  });
});

describe("getFacilityTypeMeta", () => {
  it("returns the correct meta for data_center", () => {
    expect(getFacilityTypeMeta("data_center").label).toBe("Data center");
  });

  it("returns the correct meta for crypto_mining", () => {
    expect(getFacilityTypeMeta("crypto_mining").label).toBe("Crypto mining");
  });
});
