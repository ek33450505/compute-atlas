import { describe, it, expect } from "vitest";

import { isValidCacheTag, tagsForFacility, MAX_TAGS_PER_REQUEST } from "@/lib/cache-tags";
import type { DataCenterFacility, PowerGenerationFacility, Source } from "@/lib/schema";

const source: Source = {
  url: "https://example.com/s0",
  label: "s0",
  retrievedAt: "2026-01-01",
  kind: "other",
};

function makeDoc(overrides: Partial<DataCenterFacility> & { id: string }): DataCenterFacility {
  return {
    name: "Test Facility",
    operator: "Test Operator",
    facilityType: "data_center",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact" },
    statusHistory: [],
    sources: [source],
    lastUpdated: "2026-01-01",
    ...overrides,
  };
}

function makePowerDoc(id: string, state = "GA"): PowerGenerationFacility {
  return {
    id,
    name: "Test Plant",
    operator: "Test Utility",
    facilityType: "power_generation",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 34.0, lon: -83.0, state, precision: "exact" },
    statusHistory: [],
    sources: [source],
    lastUpdated: "2026-01-01",
  };
}

describe("tagsForFacility", () => {
  it("busts the facility, state, and operator tags for a plain create, never the global 'facilities' tag", () => {
    const tags = tagsForFacility(makeDoc({ id: "some-facility-ga", operator: "Test Operator" }));

    expect(tags).toEqual(
      expect.arrayContaining(["facility:some-facility-ga", "state:GA", "operator:test-operator"])
    );
    expect(tags).not.toContain("facilities");
    expect(tags).not.toContain("power-generation");
  });

  it("busts BOTH operators when a facility changes operator, so the old operator's rail can't keep a stale entry", () => {
    const prev = makeDoc({ id: "switcher", operator: "Old Operator" });
    const next = makeDoc({ id: "switcher", operator: "New Operator" });

    const tags = tagsForFacility(next, prev);

    expect(tags).toEqual(
      expect.arrayContaining(["operator:new-operator", "operator:old-operator"])
    );
  });

  it("emits one operator tag (not two) when the operator is unchanged", () => {
    const prev = makeDoc({ id: "stayer-op", operator: "Same Operator" });
    const next = makeDoc({ id: "stayer-op", operator: "Same Operator", name: "Renamed" });

    const tags = tagsForFacility(next, prev);

    expect(tags.filter((t) => t.startsWith("operator:"))).toEqual(["operator:same-operator"]);
  });

  it("busts BOTH states when a facility moves, so the old state's landing page can't keep a stale entry", () => {
    const prev = makeDoc({ id: "mover" });
    const next = makeDoc({ id: "mover", location: { ...prev.location, state: "SC" } });

    const tags = tagsForFacility(next, prev);

    expect(tags).toEqual(expect.arrayContaining(["facility:mover", "state:SC", "state:GA"]));
  });

  it("emits one state tag (not two) when the state is unchanged", () => {
    const prev = makeDoc({ id: "stayer" });
    const next = makeDoc({ id: "stayer", name: "Renamed" });

    const tags = tagsForFacility(next, prev);

    expect(tags.filter((t) => t.startsWith("state:"))).toEqual(["state:GA"]);
  });

  it("uppercases state codes so the tag matches what lib/data.ts stamps on the cache entry", () => {
    const doc = makeDoc({
      id: "lowercase-state",
      location: { lat: 33.4, lon: -84.4, state: "ga", precision: "exact" },
    });

    expect(tagsForFacility(doc)).toContain("state:GA");
  });

  it("busts power-generation when the new doc is a power plant", () => {
    expect(tagsForFacility(makePowerDoc("some-plant"))).toContain("power-generation");
  });

  it("busts power-generation when only the PREVIOUS doc was a power plant (type changed away)", () => {
    const prev = makePowerDoc("converted");
    const next = makeDoc({ id: "converted" });

    expect(tagsForFacility(next, prev)).toContain("power-generation");
  });

  it("returns de-duplicated tags", () => {
    const prev = makePowerDoc("dupe-check");
    const next = makePowerDoc("dupe-check");

    const tags = tagsForFacility(next, prev);

    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe("isValidCacheTag", () => {
  it("accepts every tag shape tagsForFacility can produce", () => {
    const produced = [
      ...tagsForFacility(makeDoc({ id: "a-facility-slug-123" })),
      ...tagsForFacility(makePowerDoc("a-plant", "TX"), makePowerDoc("a-plant", "NV")),
    ];

    for (const tag of produced) {
      expect(isValidCacheTag(tag), tag).toBe(true);
    }
  });

  it("accepts the literal aggregate tags", () => {
    expect(isValidCacheTag("facilities")).toBe(true);
    expect(isValidCacheTag("power-generation")).toBe(true);
  });

  it("rejects malformed tags rather than letting them silently no-op", () => {
    for (const bad of [
      "",
      "facility",
      "facility:",
      "facility:Has-Uppercase",
      "facility:has_underscore",
      "state:ga",
      "state:GEORGIA",
      "state:G",
      "operator:",
      "operator:Has-Uppercase",
      "operator:has_underscore",
      "unknown-tag",
      "facilities ",
    ]) {
      expect(isValidCacheTag(bad), bad).toBe(false);
    }
  });
});

describe("MAX_TAGS_PER_REQUEST", () => {
  it("is the batch size bulk callers and the route both bound themselves by", () => {
    expect(MAX_TAGS_PER_REQUEST).toBe(100);
  });
});
