import { describe, it, expect } from "vitest";

import {
  slugBase,
  slugify,
  isHoneypotTripped,
  buildCreatePayload,
  buildCorrectionPatch,
  contributeInputSchema,
  sanitizeAttribution,
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

  // The type-flip oracle this predicate was widened to close: the three intake
  // routes used to gate this check on `typeof rawWebsite === "string"`, so
  // `{"website":1,"email":"bad"}` fell through to Zod and answered 400 with
  // `issues` while `{"website":"x","email":"bad"}` answered 201. Every type must
  // now answer identically.
  it.each([
    ["a number", 1],
    ["zero", 0],
    ["a negative number", -1],
    ["true", true],
    ["an object", { a: 1 }],
    ["an empty object", {}],
    ["a non-empty array", ["x"]],
    ["a whitespace-padded string", "  x  "],
  ])("trips on %s (non-empty after coercion)", (_label, website) => {
    expect(isHoneypotTripped({ website })).toBe(true);
  });

  it.each([
    ["undefined (absent)", undefined],
    ["null", null],
    ["false", false],
    ["an empty array (coerces to \"\")", []],
  ])("does NOT trip on %s — present but not filled in", (_label, website) => {
    expect(isHoneypotTripped({ website })).toBe(false);
  });

  it("does not trip on null or false even though String() would make them non-empty", () => {
    // Guards the explicit early return: without it, String(null) === "null" and
    // String(false) === "false" would both trip, and a client sending a JSON
    // null for an untouched hidden input would be silently treated as a bot.
    expect(String(null)).not.toBe("");
    expect(String(false)).not.toBe("");
    expect(isHoneypotTripped({ website: null })).toBe(false);
    expect(isHoneypotTripped({ website: false })).toBe(false);
  });
});

describe("slugBase", () => {
  it("returns the slug-safe part of a name, matching what slugify embeds", () => {
    expect(slugBase("Example Data Center")).toBe("example-data-center");
    // Same expression slugify uses — that shared derivation is the point.
    expect(slugify("Example Data Center", "VA")).toBe(`${slugBase("Example Data Center")}-va`);
  });

  it.each([
    ["dots", "..."],
    ["dashes", "---"],
    ["a bullet", "\u2022"],
    ["mixed punctuation", "!?!?"],
    ["whitespace", "   "],
    ["an underscore", "_"],
  ])("is EMPTY for a punctuation-only name (%s)", (_label, name) => {
    expect(slugBase(name)).toBe("");
    // Which is exactly the bug: slugify then produces a bare "-xx" id, and
    // lib/schema.ts's /^[a-z0-9-]+$/ id pattern accepts it.
    expect(slugify(name, "VA")).toBe("-va");
    expect(slugify(name, "VA")).toMatch(/^[a-z0-9-]+$/);
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

  it("appends a new subsidy record with the corrected amount, preserving existing subsidies", () => {
    const existing = baseExistingFacility({
      subsidies: [{ program: "Existing Abatement", amountUsd: 1_000_000 }],
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "subsidies",
      value: 5_000_000,
      sourceUrl: "https://example.com/subsidy-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      const subsidies = result.payload.subsidies as Array<{ amountUsd?: number; sourceIndex?: number }>;
      expect(subsidies).toHaveLength(2);
      expect(subsidies[0]).toEqual({ program: "Existing Abatement", amountUsd: 1_000_000 });
      expect(subsidies[1]).toEqual({ amountUsd: 5_000_000, sourceIndex: existing.sources.length });
      const preview = { ...existing, ...result.payload, id: existing.id };
      expect(facilitySchema.safeParse(preview).success).toBe(true);
    }
  });

  it("points the new subsidy's sourceIndex at the correction's own appended source", () => {
    const existing = baseExistingFacility({
      subsidies: [{ program: "Existing Abatement", amountUsd: 1_000_000 }],
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "subsidies",
      value: 5_000_000,
      sourceUrl: "https://example.com/subsidy-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      const subsidies = result.payload.subsidies as Array<{ sourceIndex?: number }>;
      const sources = result.payload.sources as Array<{ label: string; url: string }>;
      const newSubsidy = subsidies[subsidies.length - 1];
      expect(newSubsidy.sourceIndex).toBeDefined();
      const resolvedSource = sources[newSubsidy.sourceIndex as number];
      expect(resolvedSource.label).toBe("Correction source");
      expect(resolvedSource.url).toBe("https://example.com/subsidy-correction");
    }
  });

  it("sets jobs.permanent while preserving jobs.construction", () => {
    const existing = baseExistingFacility({
      jobs: { construction: 300, permanent: 40 },
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "jobs",
      value: 75,
      sourceUrl: "https://example.com/jobs-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload.jobs).toEqual({ construction: 300, permanent: 75 });
      const preview = { ...existing, ...result.payload, id: existing.id };
      expect(facilitySchema.safeParse(preview).success).toBe(true);
    }
  });

  it("rejects a correction targeting a still-deferred field like stakeholders", () => {
    const existing = baseExistingFacility();
    const input = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "stakeholders",
      value: "Jane Doe",
      sourceUrl: "https://example.com/correction",
    };
    const parsed = contributeInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
  });

  it("sets water.coolingType while preserving reportedMgd and notes", () => {
    const existing = baseExistingFacility({
      water: { reportedMgd: 1.2, notes: "existing note" },
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "water",
      value: "closed_loop",
      sourceUrl: "https://example.com/water-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload.water).toEqual({
        reportedMgd: 1.2,
        notes: "existing note",
        coolingType: "closed_loop",
      });
      const preview = { ...existing, ...result.payload, id: existing.id };
      expect(facilitySchema.safeParse(preview).success).toBe(true);
    }
  });

  it("rejects an invalid enum value for water", () => {
    const existing = baseExistingFacility();
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "water",
      value: "not-a-real-cooling-type",
      sourceUrl: "https://example.com/correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("error" in result).toBe(true);
  });

  it("sets energy.source while preserving utility and onSiteGenerationMw", () => {
    const existing = baseExistingFacility({
      energy: { utility: "Dominion", onSiteGenerationMw: 5 },
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "energy",
      value: "on_site_gas",
      sourceUrl: "https://example.com/energy-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload.energy).toEqual({
        utility: "Dominion",
        onSiteGenerationMw: 5,
        source: "on_site_gas",
      });
      const preview = { ...existing, ...result.payload, id: existing.id };
      expect(facilitySchema.safeParse(preview).success).toBe(true);
    }
  });

  it("rejects an invalid enum value for energy", () => {
    const existing = baseExistingFacility();
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "energy",
      value: "cold_fusion",
      sourceUrl: "https://example.com/correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("error" in result).toBe(true);
  });

  it("sets emissions.permitNumber while preserving other emissions fields", () => {
    const existing = baseExistingFacility({
      emissions: { issuingAgency: "Texas CEQ", notes: "existing note" },
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "emissions",
      value: "TCEQ-177263",
      sourceUrl: "https://example.com/emissions-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload.emissions).toEqual({
        issuingAgency: "Texas CEQ",
        notes: "existing note",
        permitNumber: "TCEQ-177263",
      });
      const preview = { ...existing, ...result.payload, id: existing.id };
      expect(facilitySchema.safeParse(preview).success).toBe(true);
    }
  });

  it("sets community.status while preserving community.notes", () => {
    const existing = baseExistingFacility({
      community: { notes: "existing note" },
    });
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "community",
      value: "contested",
      sourceUrl: "https://example.com/community-correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload.community).toEqual({
        notes: "existing note",
        status: "contested",
      });
      const preview = { ...existing, ...result.payload, id: existing.id };
      expect(facilitySchema.safeParse(preview).success).toBe(true);
    }
  });

  it("rejects an invalid enum value for community", () => {
    const existing = baseExistingFacility();
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "community",
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

describe("sanitizeAttribution", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeAttribution(undefined)).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only input", () => {
    expect(sanitizeAttribution("")).toBeUndefined();
    expect(sanitizeAttribution("   ")).toBeUndefined();
  });

  it("strips a leading @", () => {
    expect(sanitizeAttribution("@grid")).toBe("grid");
  });

  it("rejects anything email-like (contains @)", () => {
    expect(sanitizeAttribution("a@b.com")).toBeUndefined();
    expect(sanitizeAttribution("user@example")).toBeUndefined();
  });

  it("strips disallowed characters to a conservative allowlist", () => {
    // '<', '>', '/' are stripped; only alnum/space/_/./- survive.
    expect(sanitizeAttribution("<b>x</b>")).toBe("bxb");
    expect(sanitizeAttribution("grid$watcher!")).toBe("gridwatcher");
  });

  it("collapses internal whitespace to a single space", () => {
    expect(sanitizeAttribution("grid   watcher")).toBe("grid watcher");
  });

  it("hard-caps to 40 characters", () => {
    const long = "a".repeat(50);
    const result = sanitizeAttribution(long);
    expect(result).toHaveLength(40);
    expect(result).toBe("a".repeat(40));
  });

  it("passes a clean handle through unchanged", () => {
    expect(sanitizeAttribution("grid_watcher-42")).toBe("grid_watcher-42");
  });
});

// --- Finding 4: intake accepted any 2-char state and punctuation-only names.
// Both were queue-noise/data-rigor issues caught by human review, so this only
// changes what intake ACCEPTS — nothing here touches already-staged rows.

describe("contributeInputSchema state validation", () => {
  it.each(["VA", "va", "Va", "DC", "PR", "GU", "MP", "VI", "AK", "HI"])(
    "accepts the real jurisdiction code %s (case-insensitive, territories included)",
    (state) => {
      expect(contributeInputSchema.safeParse(baseCreateInput({ state })).success).toBe(true);
    }
  );

  it.each(["ZZ", "zz", "XX", "QQ", "A1", "--"])(
    "rejects the non-existent 2-letter code %s",
    (state) => {
      // `z.string().length(2)` was the whole check, so "ZZ" staged a pending
      // submission and facilitySchema (also `length(2)`) accepted it too.
      const result = contributeInputSchema.safeParse(baseCreateInput({ state }));
      expect(result.success).toBe(false);
      const issue = result.error!.issues.find((i) => i.path.includes("state"));
      expect(issue).toBeDefined();
      expect(issue!.message).toContain("Unknown US state or territory code");
    }
  );

  it("reports ONLY the length problem for a wrong-length value, never both issues", () => {
    // Zod v4 runs a `.refine()` even after an earlier check in the chain fails,
    // so the refinement deliberately passes on non-2-character input (see
    // `usStateCodeSchema`). Without that escape this field reports two issues at
    // once and the form, which keys errors by `issue.path[0]`, shows whichever
    // it picks.
    const result = contributeInputSchema.safeParse(baseCreateInput({ state: "Virginia" }));
    expect(result.success).toBe(false);
    const stateIssues = result.error!.issues.filter((i) => i.path.includes("state"));
    expect(stateIssues).toHaveLength(1);
    expect(stateIssues[0].message).not.toContain("Unknown US state or territory code");
  });
});

describe("contributeInputSchema name validation (non-empty slug base)", () => {
  it.each([
    ["dots", "..."],
    ["dashes", "---"],
    ["a bullet", "\u2022"],
    ["mixed punctuation", "!?!?"],
    ["an underscore", "_"],
    ["an emoji", "\u{1F600}"],
  ])("rejects the punctuation-only name %s, which would slugify to a bare '-xx' id", (_label, name) => {
    const result = contributeInputSchema.safeParse(baseCreateInput({ name }));
    expect(result.success).toBe(false);
    const issue = result.error!.issues.find((i) => i.path.includes("name"));
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("at least one letter or number");
  });

  it.each([
    "Example Data Center",
    "DC1",
    "Caf\u00e9's \u00dcn\u00efcode Facility, LLC!",
    "\u2022 Site 7",
    "7",
  ])("accepts %s — a name with at least one alphanumeric survives", (name) => {
    expect(contributeInputSchema.safeParse(baseCreateInput({ name })).success).toBe(true);
    expect(slugBase(name).length).toBeGreaterThan(0);
  });

  it("rejects an empty name with ONLY the min(1) issue, never both", () => {
    // Same Zod-v4 double-issue escape as the state field above.
    const result = contributeInputSchema.safeParse(baseCreateInput({ name: "" }));
    expect(result.success).toBe(false);
    const nameIssues = result.error!.issues.filter((i) => i.path.includes("name"));
    expect(nameIssues).toHaveLength(1);
    expect(nameIssues[0].message).not.toContain("at least one letter or number");
  });
});

describe("buildCorrectionPatch state field validation", () => {
  it("rejects a correction that would set an existing facility's state to a non-existent code", () => {
    // The other door into the same field: facilitySchema's location.state is
    // `z.string().length(2)` too, so "ZZ" would have validated and staged.
    const existing = baseExistingFacility();
    const input: CorrectionContributeInput = {
      kind: "correction",
      targetFacilityId: existing.id,
      field: "state",
      value: "ZZ",
      sourceUrl: "https://example.com/correction",
    };
    const result = buildCorrectionPatch(existing, input, TODAY);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("real US state or territory code");
  });

  it("accepts a correction to a real code, normalising case", () => {
    const existing = baseExistingFacility();
    const result = buildCorrectionPatch(
      existing,
      {
        kind: "correction",
        targetFacilityId: existing.id,
        field: "state",
        value: "tx",
        sourceUrl: "https://example.com/correction",
      },
      TODAY
    );
    expect("payload" in result).toBe(true);
    const location = (result as { payload: { location: { state: string } } }).payload.location;
    expect(location.state).toBe("TX");
  });

  it("still reports the LENGTH problem for a wrong-length correction value", () => {
    const existing = baseExistingFacility();
    const result = buildCorrectionPatch(
      existing,
      {
        kind: "correction",
        targetFacilityId: existing.id,
        field: "state",
        value: "Texas",
        sourceUrl: "https://example.com/correction",
      },
      TODAY
    );
    expect((result as { error: string }).error).toContain("2-letter code");
  });
});
