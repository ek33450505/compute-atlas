import { describe, it, expect } from "vitest";
import { facilitySchema } from "@/lib/schema";
import type {
  Facility,
  DataCenterFacility,
  CryptoMiningFacility,
  PowerGenerationFacility,
  Source,
} from "@/lib/schema";
import {
  applyEnrichmentUpdate,
  enrichmentUpdateIntentSchema,
  missingEnrichableFamilies,
  type EnrichmentUpdateIntent,
} from "@/lib/enrichment-update";

function makeSource(label: string): Source {
  return {
    url: `https://example.com/${label}`,
    label,
    retrievedAt: "2026-01-01",
    kind: "other" as const,
  };
}

function makeDataCenter(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test Data Center",
    operator: "Test Operator",
    facilityType: "data_center",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2026-01-01",
    ...overrides,
  };
}

function makeCryptoMining(overrides: Partial<CryptoMiningFacility> = {}): CryptoMiningFacility {
  return {
    id: "test-crypto",
    name: "Test Mining Site",
    operator: "Test Miner Co",
    facilityType: "crypto_mining",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 32.1, lon: -95.3, state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2026-01-01",
    ...overrides,
  };
}

function makePowerGeneration(overrides: Partial<PowerGenerationFacility> = {}): PowerGenerationFacility {
  return {
    id: "test-power",
    name: "Test Power Plant",
    operator: "Test Utility",
    facilityType: "power_generation",
    status: "proposed",
    confidence: "reported",
    location: { lat: 41.8, lon: -87.6, state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2026-01-01",
    generation: undefined,
    ...overrides,
  };
}

function minimalIntent(overrides: Partial<EnrichmentUpdateIntent> = {}): EnrichmentUpdateIntent {
  return {
    date: "2026-07-30",
    sources: [makeSource("enrich-0")],
    fields: {},
    ...overrides,
  };
}

describe("applyEnrichmentUpdate", () => {
  it("is append-only: sources grow by exactly intent.sources.length, existing entries unchanged", () => {
    const existing = makeDataCenter({ sources: [makeSource("s0"), makeSource("s1")] });
    const existingClone = structuredClone(existing);

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({ sources: [makeSource("s2"), makeSource("s3")] })
    );

    expect(result.sources).toHaveLength(existing.sources.length + 2);
    expect(result.sources.slice(0, 2)).toEqual(existingClone.sources);
    expect(existing).toEqual(existingClone);
  });

  it("remaps sourceRel to an exact absolute sourceIndex for jobs/community/subsidies", () => {
    const existing = makeDataCenter({ sources: [makeSource("s0"), makeSource("s1")] });

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({
        sources: [makeSource("enrich-0")],
        fields: {
          jobs: { construction: 100, sourceRel: 0 },
          community: { status: "supported", sourceRel: 0 },
          subsidies: [{ program: "new incentive", sourceRel: 0 }],
        },
      })
    );

    expect(result.jobs?.sourceIndex).toBe(2);
    expect(result.community?.sourceIndex).toBe(2);
    expect(result.subsidies?.[0]?.sourceIndex).toBe(2);
  });

  it("refuses to overwrite already-curated fields (fill-missing only)", () => {
    const existing = makeDataCenter({
      energy: { source: "grid", utility: "Existing Utility" },
      investmentUsd: 5_000_000,
      community: { status: "opposed", sourceIndex: 0 },
      jobs: { construction: 50, sourceIndex: 0 },
    });

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({
        fields: {
          energy: { source: "nuclear", utility: "New Utility" },
          investmentUsd: 999,
          community: { status: "supported", sourceRel: 0 },
          jobs: { construction: 9, sourceRel: 0 },
        },
      })
    );

    expect(result.energy?.source).toBe("grid");
    expect(result.investmentUsd).toBe(5_000_000);
    expect(result.community?.status).toBe("opposed");
    expect(result.jobs?.construction).toBe(50);
  });

  it("fills a missing sub-field without touching a present sibling sub-field", () => {
    const existing = makeDataCenter({ energy: { source: "grid" } });

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({ fields: { energy: { utility: "New Utility Co" } } })
    );

    expect(result.energy?.source).toBe("grid");
    expect(result.energy?.utility).toBe("New Utility Co");
  });

  it("dedupes subsidies by (program, year, jurisdiction) and appends only the new one", () => {
    const existing = makeDataCenter({
      sources: [makeSource("s0")],
      subsidies: [{ program: "X", year: "2024", jurisdiction: "Y", sourceIndex: 0 }],
    });

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({
        sources: [makeSource("enrich-0")],
        fields: {
          subsidies: [
            { program: "X", year: "2024", jurisdiction: "Y", sourceRel: 0 },
            { program: "New Program", year: "2025", jurisdiction: "Z", sourceRel: 0 },
          ],
        },
      })
    );

    expect(result.subsidies).toHaveLength(2);
    expect(result.subsidies?.[0]).toEqual(existing.subsidies?.[0]);
    expect(result.subsidies?.[1]).toMatchObject({ program: "New Program", sourceIndex: 1 });
  });

  it("drops aiClassification for power_generation facilities and stays schema-valid", () => {
    const existing = makePowerGeneration();

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({ fields: { aiClassification: "confirmed" } })
    );

    expect(result).not.toHaveProperty("aiClassification");
    const parsed = facilitySchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it.each([
    ["data_center", makeDataCenter],
    ["crypto_mining", makeCryptoMining],
    ["power_generation", makePowerGeneration],
  ] as const)("round-trips the %s branch through facilitySchema after apply", (_label, factory) => {
    const existing: Facility = factory();
    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({
        fields: {
          capacityMw: { planned: 100 },
          investmentUsd: 1_000_000,
          landAcres: 50,
        },
      })
    );
    expect(result.facilityType).toBe(existing.facilityType);
    const parsed = facilitySchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("does not mutate the existing facility", () => {
    const existing = makeDataCenter({
      sources: [makeSource("s0"), makeSource("s1")],
      community: { status: "mixed", sourceIndex: 1 },
    });
    const existingClone = structuredClone(existing);

    applyEnrichmentUpdate(
      existing,
      minimalIntent({
        fields: {
          capacityMw: { planned: 200 },
          jobs: { permanent: 20, sourceRel: 0 },
        },
      })
    );

    expect(existing).toEqual(existingClone);
  });

  it("regression: preserves pre-existing near-tail sourceIndex refs after an append", () => {
    const existing = makeDataCenter({
      sources: [makeSource("s0"), makeSource("s1"), makeSource("s2")],
      community: { status: "contested", sourceIndex: 2 },
      subsidies: [{ program: "old", year: "2020", jurisdiction: "State", sourceIndex: 1 }],
    });

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({
        sources: [makeSource("enrich-0"), makeSource("enrich-1")],
        fields: { investmentUsd: 42 },
      })
    );

    expect(result.community?.sourceIndex).toBe(2);
    expect(result.subsidies?.[0]?.sourceIndex).toBe(1);
    const parsed = facilitySchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("fills location street/postalCode only when currently undefined", () => {
    const existing = makeDataCenter({
      location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact", street: "123 Main St" },
    });

    const result = applyEnrichmentUpdate(
      existing,
      minimalIntent({ fields: { location: { street: "999 Other Rd", postalCode: "30301" } } })
    );

    expect(result.location.street).toBe("123 Main St");
    expect(result.location.postalCode).toBe("30301");
  });
});

describe("enrichmentUpdateIntentSchema", () => {
  it("rejects a sourceRel that is out of range for community", () => {
    const result = enrichmentUpdateIntentSchema.safeParse({
      date: "2026-07-30",
      sources: [makeSource("s0")],
      fields: { community: { status: "supported", sourceRel: 1 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown/curated fields via .strict()", () => {
    const result = enrichmentUpdateIntentSchema.safeParse({
      date: "2026-07-30",
      sources: [makeSource("s0")],
      fields: { status: "operational" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed intent", () => {
    const result = enrichmentUpdateIntentSchema.safeParse({
      date: "2026-07-30",
      sources: [makeSource("s0")],
      fields: { investmentUsd: 1000, jobs: { construction: 10, sourceRel: 0 } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty fields object", () => {
    const result = enrichmentUpdateIntentSchema.safeParse({
      date: "2026-07-30",
      sources: [makeSource("s0")],
      fields: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 sources (DoS/jsonb-bloat guard)", () => {
    const result = enrichmentUpdateIntentSchema.safeParse({
      date: "2026-07-30",
      sources: Array.from({ length: 21 }, (_, i) => makeSource(`s${i}`)),
      fields: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside fields.capacityMw via intent-side .strict()", () => {
    const result = enrichmentUpdateIntentSchema.safeParse({
      date: "2026-07-30",
      sources: [makeSource("s0")],
      fields: { capacityMw: { planned: 5, bogus: 1 } },
    });
    expect(result.success).toBe(false);
  });
});

describe("missingEnrichableFamilies", () => {
  it("reports all families missing on a bare-minimum facility", () => {
    const facility = makeDataCenter();
    const missing = missingEnrichableFamilies(facility);
    expect(missing).toEqual(
      expect.arrayContaining([
        "capacityMw",
        "energy",
        "water",
        "address",
        "investmentUsd",
        "landAcres",
        "aiClassification",
        "jobs",
        "community",
        "subsidies",
      ])
    );
  });

  it("excludes aiClassification for power_generation facilities", () => {
    const facility = makePowerGeneration();
    const missing = missingEnrichableFamilies(facility);
    expect(missing).not.toContain("aiClassification");
  });

  it("excludes a family once fully populated", () => {
    const facility = makeDataCenter({
      capacityMw: { planned: 100, operational: 100 },
      energy: { source: "grid", utility: "Utility Co", onSiteGenerationMw: 0 },
      water: { coolingType: "air", reportedMgd: 0 },
      location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact", street: "1 Main", postalCode: "30301" },
      investmentUsd: 100,
      landAcres: 10,
      aiClassification: "confirmed",
      jobs: { construction: 5 },
      community: { status: "supported" },
      subsidies: [{ program: "X" }],
    });
    expect(missingEnrichableFamilies(facility)).toEqual([]);
  });
});
