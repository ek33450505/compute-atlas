import { describe, it, expect } from "vitest";

import {
  slugify,
  isHoneypotTripped,
  buildCreatePayload,
  buildCorrectionPatch,
  contributeInputSchema,
  type CreateContributeInput,
  type CorrectionContributeInput,
} from "@/lib/contribute";
import { facilitySchema, type DataCenterFacility } from "@/lib/schema";

const TODAY = "2026-07-14";

function baseCreateInput(overrides: Partial<CreateContributeInput> = {}): CreateContributeInput {
  return {
    kind: "create",
    name: "Example Data Center",
    operator: "Example Operator",
    state: "va",
    facilityType: "data_center",
    status: "proposed",
    lat: 38.9,
    lon: -77.4,
    sourceUrl: "https://example.com/article",
    ...overrides,
  };
}

function baseExistingFacility(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "existing-facility-va",
    name: "Existing Facility",
    operator: "Existing Operator",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 38.0, lon: -77.0, state: "VA", precision: "exact" },
    capacityMw: { planned: 100, operational: 50 },
    statusHistory: [],
    sources: [
      { url: "https://example.com/existing", label: "Existing source", retrievedAt: "2026-01-01", kind: "other" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as DataCenterFacility;
}

describe("isHoneypotTripped", () => {
  it("returns false for empty/whitespace website", () => {
    expect(isHoneypotTripped({ website: "" })).toBe(false);
    expect(isHoneypotTripped({ website: "   " })).toBe(false);
    expect(isHoneypotTripped({})).toBe(false);
  });

  it("returns true for non-empty website", () => {
    expect(isHoneypotTripped({ website: "http://spam.example" })).toBe(true);
  });
});

describe("slugify", () => {
  it("produces a valid slug from a plain name", () => {
    const slug = slugify("Example Data Center", "VA");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.endsWith("-va")).toBe(true);
  });

  it("handles punctuation and unicode", () => {
    const slug = slugify("Café's Ünïcode Facility, LLC!", "TX");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("buildCreatePayload", () => {
  it("pins confidence to rumored and precision to approximate", () => {
    const payload = buildCreatePayload(baseCreateInput(), TODAY) as unknown as DataCenterFacility;
    expect(payload.confidence).toBe("rumored");
    expect(payload.location.precision).toBe("approximate");
  });

  it("uppercases the state", () => {
    const payload = buildCreatePayload(baseCreateInput({ state: "va" }), TODAY) as unknown as DataCenterFacility;
    expect(payload.location.state).toBe("VA");
  });

  it("builds a single source with the given label and today's date", () => {
    const payload = buildCreatePayload(
      baseCreateInput({ sourceLabel: "My Source" }),
      TODAY
    ) as unknown as DataCenterFacility;
    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0].label).toBe("My Source");
    expect(payload.sources[0].retrievedAt).toBe(TODAY);
  });

  it("defaults the source label when none is given", () => {
    const payload = buildCreatePayload(baseCreateInput(), TODAY) as unknown as DataCenterFacility;
    expect(payload.sources[0].label).toBe("User-submitted source");
  });

  it("sets lastUpdated to today", () => {
    const payload = buildCreatePayload(baseCreateInput(), TODAY) as unknown as DataCenterFacility;
    expect(payload.lastUpdated).toBe(TODAY);
  });

  it("includes capacityMw only when given", () => {
    const withoutCapacity = buildCreatePayload(baseCreateInput(), TODAY) as unknown as DataCenterFacility;
    expect(withoutCapacity.capacityMw).toBeUndefined();

    const withCapacity = buildCreatePayload(
      baseCreateInput({ capacityOperationalMw: 20, capacityPlannedMw: 40 }),
      TODAY
    ) as unknown as DataCenterFacility;
    expect(withCapacity.capacityMw).toEqual({ planned: 40, operational: 20 });
  });

  it("passes facilitySchema validation", () => {
    const payload = buildCreatePayload(baseCreateInput(), TODAY);
    const result = facilitySchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("honors a client-supplied status but strips unknown fields like confidence/id", () => {
    const rawWithExtras = {
      ...baseCreateInput({ status: "operational" }),
      confidence: "confirmed", // not in createSchema — must be ignored
      id: "attacker-chosen-id", // not in createSchema — must be ignored
    };
    const payload = buildCreatePayload(rawWithExtras as CreateContributeInput, TODAY) as unknown as DataCenterFacility;
    expect(payload.status).toBe("operational");
    expect(payload.confidence).toBe("rumored"); // server-pinned, not attacker value
    expect(payload.id).not.toBe("attacker-chosen-id"); // server-derived via slugify
  });
});

describe("buildCorrectionPatch nested-merge safety", () => {
  it("preserves capacityMw.planned when only operational is corrected", () => {
    const existing = baseExistingFacility({ capacityMw: { planned: 100, operational: 50 } });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "capacityOperationalMw",
      value: 60,
      sourceUrl: "https://example.com/correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload.capacityMw).toEqual({ planned: 100, operational: 60 });
    }
  });

  it("preserves location.lat/lon when only state is corrected", () => {
    const existing = baseExistingFacility({
      location: { lat: 38.123, lon: -77.456, state: "VA", precision: "exact" },
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "state",
      value: "nc",
      sourceUrl: "https://example.com/correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      const location = result.payload.location as Record<string, unknown>;
      expect(location.lat).toBe(38.123);
      expect(location.lon).toBe(-77.456);
      expect(location.state).toBe("NC");
    }
  });

  it("appends the correction source while retaining existing sources", () => {
    const existing = baseExistingFacility();
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "operator",
      value: "New Operator",
      sourceUrl: "https://example.com/new-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      const sources = result.payload.sources as Array<{ url: string }>;
      expect(sources).toHaveLength(existing.sources.length + 1);
      expect(sources[0].url).toBe(existing.sources[0].url);
      expect(sources[sources.length - 1].url).toBe("https://example.com/new-correction");
    }
  });

  it("produces a merged preview that passes facilitySchema", () => {
    const existing = baseExistingFacility({ capacityMw: { planned: 100, operational: 50 } });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "capacityOperationalMw",
      value: 75,
      sourceUrl: "https://example.com/correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      const preview = { ...existing, ...result.payload, id: existing.id };
      expect(facilitySchema.safeParse(preview).success).toBe(true);
    }
  });

  it("rejects an invalid enum value for status", () => {
    const existing = baseExistingFacility();
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "status",
      value: "not-a-real-status",
      sourceUrl: "https://example.com/correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("error" in result).toBe(true);
  });
});

describe("contributeInputSchema length caps", () => {
  it("rejects a create input whose name exceeds 200 characters", () => {
    const overlongName = "a".repeat(201);
    const result = contributeInputSchema.safeParse(baseCreateInput({ name: overlongName }));
    expect(result.success).toBe(false);
  });

  it("rejects a correction input whose value exceeds 2000 characters", () => {
    const overlongValue = "a".repeat(2001);
    const input = {
      kind: "correction",
      targetFacilityId: "existing-facility-va",
      field: "name",
      value: overlongValue,
      sourceUrl: "https://example.com/correction",
    };
    const result = contributeInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
