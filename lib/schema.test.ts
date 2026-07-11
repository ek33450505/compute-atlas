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
  facilityType: "data_center" as const,
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

const baseCryptoMiningFacility = {
  id: "test-mining-facility",
  name: "Test Mining Facility",
  operator: "Test Mining Operator",
  status: "operational" as const,
  facilityType: "crypto_mining" as const,
  confidence: "reported" as const,
  location: {
    lat: 30.0,
    lon: -97.0,
    state: "TX",
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

describe("facilitySchema — civic-impact fields (happy path)", () => {
  it("parses a valid facility with all new fields populated", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      energy: {
        source: "solar",
        utility: "TVA",
        onSiteGenerationMw: 50,
        notes: "On-site solar array",
      },
      water: {
        coolingType: "evaporative",
        reportedMgd: 2.5,
        notes: "Uses cooling towers",
      },
      subsidies: [
        {
          program: "Tax Increment Financing",
          amountUsd: 1000000,
          jurisdiction: "Shelby County",
          year: "2024",
          sourceIndex: 0,
        },
      ],
      investmentUsd: 500000000,
      landAcres: 120,
      jobs: {
        construction: 500,
        permanent: 50,
        sourceIndex: 0,
      },
      community: {
        status: "supported",
        notes: "Local council approved",
        sourceIndex: 0,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.energy?.source).toBe("solar");
      expect(result.data.subsidies?.[0].amountUsd).toBe(1000000);
    }
  });

  it("new fields are optional — omitting them still parses", () => {
    const result = facilitySchema.safeParse(baseFacility);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.energy).toBeUndefined();
      expect(result.data.water).toBeUndefined();
      expect(result.data.subsidies).toBeUndefined();
      expect(result.data.community).toBeUndefined();
    }
  });
});

describe("facilitySchema — civic-impact fields (invalid cases)", () => {
  it("fails when energy.source is an invalid enum value", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      energy: { source: "coal" },
    });
    expect(result.success).toBe(false);
  });

  it("fails when water.reportedMgd is negative", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      water: { reportedMgd: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("fails when investmentUsd is zero", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      investmentUsd: 0,
    });
    expect(result.success).toBe(false);
  });

  it("fails when investmentUsd is negative", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      investmentUsd: -1000,
    });
    expect(result.success).toBe(false);
  });

  it("fails when subsidies[0].sourceIndex is out of range", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      subsidies: [{ program: "TIF", sourceIndex: 5 }],
    });
    expect(result.success).toBe(false);
  });

  it("fails when community.sourceIndex is out of range", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      community: { status: "supported", sourceIndex: 5 },
    });
    expect(result.success).toBe(false);
  });

  it("fails when jobs.sourceIndex is out of range", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      jobs: { construction: 100, sourceIndex: 5 },
    });
    expect(result.success).toBe(false);
  });

  it("fails when jobs.construction is negative", () => {
    const result = facilitySchema.safeParse({
      ...baseFacility,
      jobs: { construction: -5 },
    });
    expect(result.success).toBe(false);
  });
});

describe("facilitySchema — crypto_mining branch (happy path)", () => {
  it("parses a minimal valid crypto_mining record", () => {
    const result = facilitySchema.safeParse(baseCryptoMiningFacility);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.facilityType).toBe("crypto_mining");
    }
  });

  it("aiClassification is optional and omitted for crypto_mining", () => {
    const result = facilitySchema.safeParse(baseCryptoMiningFacility);
    expect(result.success).toBe(true);
    if (result.success && result.data.facilityType === "crypto_mining") {
      expect(result.data.aiClassification).toBeUndefined();
    }
  });

  it("parses a crypto_mining record with mining and environmental fields populated", () => {
    const result = facilitySchema.safeParse({
      ...baseCryptoMiningFacility,
      mining: {
        hashRateThPerS: 500,
        hardwareType: "asic",
        coolingType: "immersion",
        powerArrangement: "stranded_gas",
      },
      environmental: {
        carbonIntensityProxy: 350,
        carbonIntensityBasis: "estimated",
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.facilityType === "crypto_mining") {
      expect(result.data.mining?.powerArrangement).toBe("stranded_gas");
      expect(result.data.environmental?.carbonIntensityBasis).toBe("estimated");
    }
  });
});

describe("facilitySchema — crypto_mining branch (invalid cases)", () => {
  it("fails when facilityType is missing", () => {
    const withoutType: Record<string, unknown> = { ...baseCryptoMiningFacility };
    delete withoutType.facilityType;
    const result = facilitySchema.safeParse(withoutType);
    expect(result.success).toBe(false);
  });

  it("fails when mining.hardwareType is an invalid enum value", () => {
    const result = facilitySchema.safeParse({
      ...baseCryptoMiningFacility,
      mining: { hardwareType: "quantum" },
    });
    expect(result.success).toBe(false);
  });

  it("fails when statusHistory sourceIndex is out of range on the crypto_mining branch", () => {
    const result = facilitySchema.safeParse({
      ...baseCryptoMiningFacility,
      statusHistory: [
        { status: "operational", date: "2024", sourceIndex: 5 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("facilitySchema — location.precision", () => {
  it("parses a representative_multi_site record with a multiSite block", () => {
    const result = facilitySchema.safeParse({
      ...baseCryptoMiningFacility,
      location: {
        ...baseCryptoMiningFacility.location,
        precision: "representative_multi_site" as const,
        multiSite: { states: ["TX", "ND"] },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.location.precision).toBe("representative_multi_site");
      expect(result.data.location.multiSite?.states).toEqual(["TX", "ND"]);
    }
  });

  it("defaults location.precision to exact when omitted", () => {
    const result = facilitySchema.safeParse(baseFacility);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.location.precision).toBe("exact");
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
