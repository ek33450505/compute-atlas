import { describe, it, expect } from "vitest";
import { facilitySchema } from "@/lib/schema";
import type {
  Facility,
  DataCenterFacility,
  CryptoMiningFacility,
  PowerGenerationFacility,
  Source,
} from "@/lib/schema";
import { applyStatusUpdate, statusUpdateIntentSchema } from "@/lib/status-update";

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

describe("applyStatusUpdate", () => {
  it("fixes THE regression: dangling sourceIndex refs on community/subsidies stay valid after an append-only update", () => {
    const existing = makeDataCenter({
      sources: [makeSource("s0"), makeSource("s1"), makeSource("s2"), makeSource("s3")],
      statusHistory: [
        { status: "permitted", date: "2025-06-01", sourceIndex: 0 },
      ],
      community: { status: "supported", sourceIndex: 3 },
      subsidies: [{ program: "tax abatement", sourceIndex: 2 }],
    });
    const existingClone = structuredClone(existing);

    const result = applyStatusUpdate(existing, {
      status: "operational",
      date: "2026-07-16",
      sources: [makeSource("new-corroborating-source")],
    });

    const parsed = facilitySchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

    expect(result.community?.sourceIndex).toBe(3);
    expect(result.subsidies?.[0]?.sourceIndex).toBe(2);
    expect(result.status).toBe("operational");
    expect(result.sources).toHaveLength(5);
    expect(result.lastUpdated).toBe("2026-07-16");

    const appendedEntry = result.statusHistory[result.statusHistory.length - 1];
    expect(appendedEntry.sourceIndex).toBe(4);
    expect(appendedEntry.status).toBe("operational");
    expect(appendedEntry.date).toBe("2026-07-16");

    // existing must be untouched
    expect(existing).toEqual(existingClone);
  });

  it("appends the first statusHistory entry when statusHistory is empty/absent", () => {
    const existing = makeDataCenter({ sources: [makeSource("s0"), makeSource("s1")] });
    const result = applyStatusUpdate(existing, {
      status: "cancelled",
      date: "2026-03-01",
      sources: [makeSource("s2")],
    });
    expect(result.statusHistory).toHaveLength(1);
    expect(result.statusHistory[0].sourceIndex).toBe(2);
  });

  it("points the new statusHistory entry's sourceIndex at the FIRST of multiple appended sources", () => {
    const existing = makeDataCenter({ sources: [makeSource("s0")] });
    const result = applyStatusUpdate(existing, {
      status: "operational",
      date: "2026-05-01",
      sources: [makeSource("s1"), makeSource("s2"), makeSource("s3")],
    });
    expect(result.sources).toHaveLength(4);
    const entry = result.statusHistory[result.statusHistory.length - 1];
    expect(entry.sourceIndex).toBe(1);
  });

  it("omits the note key entirely when intent.note is absent", () => {
    const existing = makeDataCenter();
    const result = applyStatusUpdate(existing, {
      status: "operational",
      date: "2026-05-01",
      sources: [makeSource("s1")],
    });
    const entry = result.statusHistory[result.statusHistory.length - 1];
    expect(entry).not.toHaveProperty("note");
  });

  it("includes the note when intent.note is provided", () => {
    const existing = makeDataCenter();
    const result = applyStatusUpdate(existing, {
      status: "operational",
      date: "2026-05-01",
      note: "confirmed via press release",
      sources: [makeSource("s1")],
    });
    const entry = result.statusHistory[result.statusHistory.length - 1];
    expect(entry.note).toBe("confirmed via press release");
  });

  it.each([
    ["data_center", makeDataCenter],
    ["crypto_mining", makeCryptoMining],
    ["power_generation", makePowerGeneration],
  ] as const)("round-trips the %s branch through facilitySchema after apply", (_label, factory) => {
    const existing: Facility = factory();
    const result = applyStatusUpdate(existing, {
      status: "operational",
      date: "2026-07-16",
      sources: [makeSource("corroboration")],
    });
    expect(result.facilityType).toBe(existing.facilityType);
    const parsed = facilitySchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("leaves unrelated fields (name, operator, location) untouched", () => {
    const existing = makeDataCenter({ name: "Untouched Name", operator: "Untouched Operator" });
    const result = applyStatusUpdate(existing, {
      status: "operational",
      date: "2026-07-16",
      sources: [makeSource("s1")],
    });
    expect(result.name).toBe("Untouched Name");
    expect(result.operator).toBe("Untouched Operator");
    expect(result.location).toEqual(existing.location);
  });
});

describe("statusUpdateIntentSchema", () => {
  it("rejects an empty sources array", () => {
    const result = statusUpdateIntentSchema.safeParse({
      status: "operational",
      date: "2026-07-16",
      sources: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status value", () => {
    const result = statusUpdateIntentSchema.safeParse({
      status: "not_a_real_status",
      date: "2026-07-16",
      sources: [makeSource("s0")],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed intent", () => {
    const result = statusUpdateIntentSchema.safeParse({
      status: "operational",
      date: "2026-07-16",
      sources: [makeSource("s0")],
    });
    expect(result.success).toBe(true);
  });
});
