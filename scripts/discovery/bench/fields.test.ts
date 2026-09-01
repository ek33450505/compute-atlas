// Tests for fields.mjs -- the field-kind/vocabulary map shared by run.mjs
// (prompt) and rescore.mjs (scorer). See fields.mjs's header for why this
// module exists (same rationale as quote.mjs / quote-parity.test.ts).
import { describe, it, expect } from "vitest";

import {
  KIND,
  FIELD_ENUM_VALUES,
  fieldKind,
  isInVocabulary,
  normalizeEnum,
  normalizeText,
  enumEquals,
  textEquals,
  numericValue,
  numericClose,
} from "./fields.mjs";

describe("fieldKind", () => {
  it("classifies the four existing capacity/generation fields as numeric", () => {
    expect(fieldKind("capacityAny")).toBe(KIND.NUMERIC);
    expect(fieldKind("capacityPlanned")).toBe(KIND.NUMERIC);
    expect(fieldKind("capacityOperational")).toBe(KIND.NUMERIC);
    expect(fieldKind("onSiteGenerationMw")).toBe(KIND.NUMERIC);
  });

  it("classifies coolingType and energySource as enum, energyUtility as text", () => {
    expect(fieldKind("coolingType")).toBe(KIND.ENUM);
    expect(fieldKind("energySource")).toBe(KIND.ENUM);
    expect(fieldKind("energyUtility")).toBe(KIND.TEXT);
  });

  it("defaults an undeclared field to numeric (preserves pre-existing behaviour)", () => {
    expect(fieldKind("someUnknownField")).toBe(KIND.NUMERIC);
  });
});

describe("enum vocabularies (must match lib/schema.ts)", () => {
  it("coolingType matches waterSchema.coolingType", () => {
    expect(FIELD_ENUM_VALUES.coolingType).toEqual(["evaporative", "air", "closed_loop", "hybrid", "unknown"]);
  });

  it("energySource matches energySchema.source", () => {
    expect(FIELD_ENUM_VALUES.energySource).toEqual([
      "grid", "on_site_gas", "nuclear", "solar", "wind", "hydro", "mixed", "other",
    ]);
  });
});

describe("normalizeEnum", () => {
  it("normalises 'Closed-Loop', 'closed loop', and 'CLOSED_LOOP' to the same token", () => {
    expect(normalizeEnum("Closed-Loop")).toBe("closed_loop");
    expect(normalizeEnum("closed loop")).toBe("closed_loop");
    expect(normalizeEnum("CLOSED_LOOP")).toBe("closed_loop");
  });

  it("returns null for null/undefined/empty", () => {
    expect(normalizeEnum(null)).toBeNull();
    expect(normalizeEnum(undefined)).toBeNull();
    expect(normalizeEnum("")).toBeNull();
    expect(normalizeEnum("   ")).toBeNull();
  });

  it("does not silently drop an out-of-vocabulary value -- it normalises but stays non-null", () => {
    // "immersion" is a real mining.coolingType value, not a valid
    // water.coolingType value -- it must NOT collapse to null (which would
    // be scored as a miss instead of WRONG).
    expect(normalizeEnum("immersion")).toBe("immersion");
    expect(isInVocabulary(normalizeEnum("immersion"), FIELD_ENUM_VALUES.coolingType)).toBe(false);
  });
});

describe("enumEquals", () => {
  it("matches normalised variants", () => {
    expect(enumEquals("Closed-Loop", "closed_loop")).toBe(true);
    expect(enumEquals("closed loop", "closed_loop")).toBe(true);
    expect(enumEquals("CLOSED_LOOP", "closed_loop")).toBe(true);
  });

  it("does not match a genuinely different enum value", () => {
    expect(enumEquals("air", "closed_loop")).toBe(false);
  });

  it("null expected + null got is not a match via enumEquals (caller treats that as abstain-ok separately)", () => {
    expect(enumEquals(null, null)).toBe(false);
  });

  it("null expected + a real value is not a match (caller treats that as hallucination separately)", () => {
    expect(enumEquals("closed_loop", null)).toBe(false);
  });
});

describe("isInVocabulary", () => {
  it("an out-of-vocabulary answer (e.g. 'immersion' for coolingType) is not in the declared vocabulary", () => {
    expect(isInVocabulary(normalizeEnum("immersion"), FIELD_ENUM_VALUES.coolingType)).toBe(false);
  });

  it("a valid vocabulary member is recognised", () => {
    expect(isInVocabulary(normalizeEnum("closed_loop"), FIELD_ENUM_VALUES.coolingType)).toBe(true);
    expect(isInVocabulary(normalizeEnum("Closed-Loop"), FIELD_ENUM_VALUES.coolingType)).toBe(true);
  });
});

describe("normalizeText", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeText("Georgia Power ")).toBe("georgia power");
    expect(normalizeText("  Georgia   Power  ")).toBe("georgia power");
  });

  it("strips trailing punctuation", () => {
    expect(normalizeText("Georgia Power.")).toBe("georgia power");
  });

  it("returns null for null/undefined/empty", () => {
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(undefined)).toBeNull();
    expect(normalizeText("")).toBeNull();
  });
});

describe("textEquals", () => {
  it("'Georgia Power ' matches 'georgia power'", () => {
    expect(textEquals("Georgia Power ", "georgia power")).toBe(true);
  });

  it("a genuinely different utility does not match", () => {
    expect(textEquals("Georgia Power", "Duke Energy")).toBe(false);
  });

  it("no fuzzy matching -- a near-miss spelling does not match", () => {
    expect(textEquals("Georgia Powr", "Georgia Power")).toBe(false);
  });
});

describe("numericValue / numericClose (unchanged, moved verbatim from rescore.mjs)", () => {
  it("parses a plain number and a numeric string with a unit suffix", () => {
    expect(numericValue(540)).toBe(540);
    expect(numericValue("540 MW")).toBe(540);
    expect(numericValue("1,000")).toBe(1000);
  });

  it("returns null when nothing numeric is present", () => {
    expect(numericValue(null)).toBeNull();
    expect(numericValue(undefined)).toBeNull();
    expect(numericValue("closed_loop")).toBeNull();
  });

  it("5% relative tolerance: within tolerance matches, outside does not", () => {
    expect(numericClose(100, 104)).toBe(true); // 4% relative diff
    expect(numericClose(100, 106)).toBe(false); // 6% relative diff
    expect(numericClose(100, 100)).toBe(true);
  });

  it("null on either side never matches", () => {
    expect(numericClose(null, 100)).toBe(false);
    expect(numericClose(100, null)).toBe(false);
  });
});

// The accept<Field> alternates mechanism (truth.json labels) is exercised in
// rescore.mjs's main loop as `accepts.some((a) => valuesEqual(kind, got, a))`.
// These tests cover the underlying equality primitive that mechanism relies
// on for enum/text kinds -- i.e. that a listed alternate normalises and
// compares the same way a single expected value does.
describe("accept<Field> alternates mechanism (equality primitive)", () => {
  it("a listed text alternate matches when normalised the same way as the primary expected value", () => {
    const accepts = ["Georgia Power", "Georgia Power Company"];
    const got = normalizeText("Georgia Power Company");
    expect(accepts.some((a) => textEquals(got, a))).toBe(true);
  });

  it("a listed enum alternate matches when normalised the same way as the primary expected value", () => {
    const accepts = ["closed loop", "closed_loop"];
    const got = normalizeEnum("Closed-Loop");
    expect(accepts.some((a) => enumEquals(got, a))).toBe(true);
  });
});
