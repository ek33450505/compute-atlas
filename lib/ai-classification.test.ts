import { describe, it, expect } from "vitest";
import {
  AI_CLASSIFICATION_ENTRIES,
  AI_CLASSIFICATION_CONFIDENCE_LABELS,
} from "./ai-classification";
import { AI_CLASSIFICATION_CONFIDENCE_LABELS as reExportedFromFormat } from "./format";
import { aiClassificationEnum } from "./schema";

describe("AI_CLASSIFICATION_ENTRIES", () => {
  it("has exactly 3 entries", () => {
    expect(AI_CLASSIFICATION_ENTRIES).toHaveLength(3);
  });

  it("contains all three classification keys, in display order", () => {
    expect(AI_CLASSIFICATION_ENTRIES.map((e) => e.key)).toEqual([
      "confirmed",
      "likely",
      "mixed_use",
    ]);
  });

  it("confirmed: has the canonical label and description", () => {
    const entry = AI_CLASSIFICATION_ENTRIES.find((e) => e.key === "confirmed");
    expect(entry?.label).toBe("Confirmed");
    expect(entry?.description).toBe(
      "The operator or a credible primary source explicitly describes the facility as an AI or GPU cluster — xAI Colossus, for example."
    );
  });

  it("likely: has the canonical label and description", () => {
    const entry = AI_CLASSIFICATION_ENTRIES.find((e) => e.key === "likely");
    expect(entry?.label).toBe("Likely");
    expect(entry?.description).toBe(
      "The facility exhibits strong indicators — hyperscale GPU procurement, AI-specific power agreements — but has not been explicitly confirmed as AI-primary."
    );
  });

  it("mixed_use: has the canonical label and description", () => {
    const entry = AI_CLASSIFICATION_ENTRIES.find((e) => e.key === "mixed_use");
    expect(entry?.label).toBe("Mixed use");
    expect(entry?.description).toBe(
      "A multi-purpose campus where AI workloads are a known component but not necessarily the primary or exclusive use."
    );
  });

  it("uses real em-dash characters, not HTML entities, in descriptions", () => {
    for (const entry of AI_CLASSIFICATION_ENTRIES) {
      expect(entry.description).not.toMatch(/&mdash;|&#8212;/);
    }
  });
});

describe("AI_CLASSIFICATION_CONFIDENCE_LABELS", () => {
  it("is derived from AI_CLASSIFICATION_ENTRIES — same key, same label, no drift", () => {
    for (const entry of AI_CLASSIFICATION_ENTRIES) {
      expect(AI_CLASSIFICATION_CONFIDENCE_LABELS[entry.key]).toBe(entry.label);
    }
  });

  it("has exactly the same keys as AI_CLASSIFICATION_ENTRIES, no extras", () => {
    expect(Object.keys(AI_CLASSIFICATION_CONFIDENCE_LABELS).sort()).toEqual(
      AI_CLASSIFICATION_ENTRIES.map((e) => e.key).sort()
    );
  });

  it("is re-exported from lib/format.ts as the exact same object, not a duplicate literal", () => {
    // Guards against a regression back to two independent sources of truth:
    // if lib/format.ts ever re-gains its own literal instead of re-exporting,
    // this identity check breaks even though the values might still match.
    expect(reExportedFromFormat).toBe(AI_CLASSIFICATION_CONFIDENCE_LABELS);
  });
});

describe("display-order totality", () => {
  // `lib/ai-classification.ts`'s internal `TIER_ORDER` array is only checked
  // for VALIDITY at compile time (`satisfies readonly AiClassification[]`
  // rejects a bogus key, but a member missing from the array still compiles).
  // AI_CLASSIFICATION_ENTRIES is a 1:1 map over TIER_ORDER (same keys, same
  // order, nothing added or filtered), so asserting its keys cover every
  // aiClassificationEnum member is equivalent to asserting TIER_ORDER does —
  // this is the runtime test that catches a tier present in the (exhaustively
  // checked) TIERS map but missing from the display order.
  it("AI_CLASSIFICATION_ENTRIES covers every aiClassificationEnum member", () => {
    expect(AI_CLASSIFICATION_ENTRIES.map((e) => e.key).sort()).toEqual(
      [...aiClassificationEnum.options].sort()
    );
  });
});
