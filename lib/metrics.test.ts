import { describe, it, expect } from "vitest";
import { getEnvironmentalImpactIndex } from "./metrics";
import type { DataCenterFacility, CryptoMiningFacility } from "@/lib/schema";

function makeSource() {
  return {
    url: "https://example.com",
    label: "Example Source",
    retrievedAt: "2024-01-01",
    kind: "press" as const,
  };
}

function makeDataCenter(
  overrides: Partial<DataCenterFacility> = {}
): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test Datacenter",
    operator: "Test Corp",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 35.0, lon: -90.0, state: "TN", precision: "exact" },
    statusHistory: [],
    sources: [makeSource()],
    lastUpdated: "2024-01-01",
    ...overrides,
  };
}

function makeCryptoMining(
  overrides: Partial<CryptoMiningFacility> = {}
): CryptoMiningFacility {
  return {
    id: "test-mining",
    name: "Test Mining Facility",
    operator: "Test Mining Corp",
    status: "operational",
    facilityType: "crypto_mining",
    confidence: "reported",
    location: { lat: 30.0, lon: -97.0, state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [makeSource()],
    lastUpdated: "2024-01-01",
    ...overrides,
  };
}

describe("getEnvironmentalImpactIndex — no data", () => {
  it("returns score: null (not 0) when a data-center facility has no environmental block", () => {
    const result = getEnvironmentalImpactIndex(makeDataCenter());
    expect(result.score).toBeNull();
    expect(result.dataCompleteness).toBe(0);
  });

  it("returns score: null when a crypto_mining facility has no environmental block and no grid-tied eGRID fallback applies", () => {
    const result = getEnvironmentalImpactIndex(
      makeCryptoMining({ mining: { powerArrangement: "flared_gas" } })
    );
    expect(result.score).toBeNull();
    expect(result.dataCompleteness).toBe(0);
  });

  it("returns score: null when environmental exists but has no populated fields", () => {
    const result = getEnvironmentalImpactIndex(
      makeDataCenter({ environmental: { waterStress: "unknown" } })
    );
    expect(result.score).toBeNull();
  });
});

describe("getEnvironmentalImpactIndex — data center", () => {
  it("maps pue 1.0 to a score of 100", () => {
    const result = getEnvironmentalImpactIndex(
      makeDataCenter({ environmental: { pue: 1.0, waterStress: "unknown" } })
    );
    expect(result.score).toBe(100);
    expect(result.dataCompleteness).toBeCloseTo(1 / 3);
  });

  it("maps pue 2.5 to a score of 0", () => {
    const result = getEnvironmentalImpactIndex(
      makeDataCenter({ environmental: { pue: 2.5, waterStress: "unknown" } })
    );
    expect(result.score).toBe(0);
  });

  it("uses renewablePercent directly as a 0-100 sub-score", () => {
    const result = getEnvironmentalImpactIndex(
      makeDataCenter({
        environmental: { renewablePercent: 80, waterStress: "unknown" },
      })
    );
    expect(result.score).toBe(80);
  });

  it("averages only the present sub-scores across pue and renewablePercent", () => {
    const result = getEnvironmentalImpactIndex(
      makeDataCenter({
        environmental: { pue: 1.0, renewablePercent: 50, waterStress: "unknown" },
      })
    );
    // scorePue(1.0) = 100, renewablePercent sub-score = 50 -> avg 75
    expect(result.score).toBe(75);
    expect(result.dataCompleteness).toBeCloseTo(2 / 3);
  });

  it("dataCompleteness is 1 when all three expected data-center fields are present", () => {
    const result = getEnvironmentalImpactIndex(
      makeDataCenter({
        environmental: {
          pue: 1.5,
          renewablePercent: 40,
          gridCarbonIntensityGCo2PerKwh: 300,
          waterStress: "unknown",
        },
      })
    );
    expect(result.dataCompleteness).toBe(1);
    expect(result.score).not.toBeNull();
  });
});

describe("getEnvironmentalImpactIndex — crypto mining", () => {
  it("inverts carbonIntensityProxy into a 0-100 band", () => {
    const zeroCarbon = getEnvironmentalImpactIndex(
      makeCryptoMining({ environmental: { carbonIntensityProxy: 0 } })
    );
    expect(zeroCarbon.score).toBe(100);
    expect(zeroCarbon.dataCompleteness).toBe(1);
  });

  it("does not use data-center-only fields (pue) for crypto_mining facilities", () => {
    const result = getEnvironmentalImpactIndex(
      makeCryptoMining({ mining: { powerArrangement: "flared_gas" } })
    );
    expect(result.score).toBeNull();
  });
});

describe("getEnvironmentalImpactIndex — eGRID fallback", () => {
  it("falls back to the TX eGRID lookup for a grid-tied data center with no environmental block", () => {
    const result = getEnvironmentalImpactIndex(
      makeDataCenter({ location: { lat: 32.0, lon: -97.0, state: "TX", precision: "exact" } })
    );
    expect(result.score).not.toBeNull();
    expect(result.dataCompleteness).toBeCloseTo(1 / 3);
  });

  it("does not fall back for a crypto_mining facility on flared gas (off-grid arrangement)", () => {
    const result = getEnvironmentalImpactIndex(
      makeCryptoMining({ mining: { powerArrangement: "flared_gas" } })
    );
    expect(result.score).toBeNull();
    expect(result.dataCompleteness).toBe(0);
  });
});
