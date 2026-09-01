import { describe, it, expect, vi } from "vitest";

import {
  selectGaps,
  prefilter,
  windowText,
  distinctiveTokens,
  quoteVerbatim,
  quoteSupportsValue,
  toEnrichmentIntents,
  parseFieldsArg,
  runExtract,
  isDuplicateOfRecordedSibling,
  isOperationalStatusContradiction,
  detectSiblingValueCollision,
  sortSourcesPrimaryFirst,
  EXTRACTABLE_FIELDS,
  CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD,
  type AcceptedExtraction,
  type RunExtractDeps,
} from "./extract-fields";
import { enrichmentUpdateIntentSchema } from "../../lib/enrichment-update";
import type { Facility, Source } from "../../lib/schema";

function makeFacility(overrides: {
  id?: string;
  capacityMw?: Facility["capacityMw"];
  energy?: Facility["energy"];
  status?: Facility["status"];
} = {}): Facility {
  return {
    id: overrides.id ?? "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: overrides.status ?? "operational",
    facilityType: "data_center",
    confidence: "confirmed",
    location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [{ url: "https://example.com/source", label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
    lastUpdated: "2026-01-01",
    capacityMw: overrides.capacityMw,
    energy: overrides.energy,
  };
}

describe("selectGaps", () => {
  it("only returns fields that are currently undefined on each facility", () => {
    const withCapacity = makeFacility({ id: "with-capacity", capacityMw: { operational: 100 } });
    const withoutCapacity = makeFacility({ id: "without-capacity" });

    const gaps = selectGaps([withCapacity, withoutCapacity], ["capacityMw.operational", "energy.source"]);

    expect(gaps).toEqual([
      { facility: withCapacity, field: "energy.source" },
      { facility: withoutCapacity, field: "capacityMw.operational" },
      { facility: withoutCapacity, field: "energy.source" },
    ]);
  });

  it("returns no gaps when every requested field is already set", () => {
    const complete = makeFacility({ capacityMw: { operational: 50 }, energy: { source: "grid" } });
    expect(selectGaps([complete], ["capacityMw.operational", "energy.source"])).toEqual([]);
  });
});

describe("prefilter", () => {
  it("matches kW, MW, and GW mentions for numeric fields", () => {
    expect(prefilter("Capacity: 500 kW total", "capacityMw.operational")).toBe(true);
    expect(prefilter("Capacity: 500 MW total", "capacityMw.operational")).toBe(true);
    expect(prefilter("Capacity: 1.5 GW total", "capacityMw.operational")).toBe(true);
  });

  it("rejects text with no power unit mention for numeric fields", () => {
    expect(prefilter("The facility broke ground in 2024 and created many jobs.", "capacityMw.planned")).toBe(false);
    expect(prefilter("The facility broke ground in 2024 and created many jobs.", "energy.onSiteGenerationMw")).toBe(
      false
    );
  });

  it('matches capacity with en dash (U+2013) separator', () => {
    // Comprehensive coverage for the prefilter regex (POWER_UNIT_RE). This case
    // uses an en dash, a real published-prose punctuation mark, as the only
    // capacity mention on a page. Before the dash-class fix (s97), the prefilter
    // regex would silently reject this page, never reaching the model — making
    // the resulting gap indistinguishable from "the page does not state capacity".
    expect(prefilter('The facility is a 36–megawatt data center', 'capacityMw.operational')).toBe(true);
    expect(prefilter('The facility is a 36–megawatt data center', 'capacityMw.planned')).toBe(true);
  });

  it('matches capacity with em dash (U+2014) separator', () => {
    expect(prefilter('The facility is a 36—megawatt data center', 'capacityMw.operational')).toBe(true);
    expect(prefilter('The facility is a 36—megawatt data center', 'energy.onSiteGenerationMw')).toBe(true);
  });

  it('matches capacity with soft hyphen (U+00AD) separator', () => {
    // Newly-covered gap: before the \p{Pd}-category fix, this silently
    // skipped the prefilter (the model was never called) and the resulting
    // gap read as "the page does not state a capacity" — indistinguishable
    // from a page that genuinely never mentions one. U+00AD is category Cf
    // (format), outside \p{Pd}, so it must stay an explicit addition.
    expect(prefilter('The facility is a 36­megawatt data center', 'capacityMw.operational')).toBe(true);
    expect(prefilter('The facility is a 36­megawatt data center', 'capacityMw.planned')).toBe(true);
  });

  it('matches capacity with fullwidth hyphen-minus (U+FF0D) separator', () => {
    // Newly-covered gap: U+FF0D IS inside \p{Pd} (verified empirically in
    // node), so this is picked up by the category escape with no explicit
    // addition needed.
    expect(prefilter('The facility is a 36－megawatt data center', 'capacityMw.operational')).toBe(true);
    expect(prefilter('The facility is a 36－megawatt data center', 'energy.onSiteGenerationMw')).toBe(true);
  });

  it('matches capacity with hyphen bullet (U+2043) separator', () => {
    // Newly-covered gap: U+2043 sits outside \p{Pd} (category Po, not Pd) —
    // the one most likely to be missed since it visually reads as a dash.
    // Must stay an explicit addition alongside the category escape.
    expect(prefilter('The facility is a 36⁃megawatt data center', 'capacityMw.operational')).toBe(true);
    expect(prefilter('The facility is a 36⁃megawatt data center', 'capacityMw.planned')).toBe(true);
  });

  it('rejects text with no power unit mention even when it contains a number', () => {
    expect(prefilter('The facility covers 36 acres and was built in 2024', 'capacityMw.operational')).toBe(false);
  });
});

describe("windowText", () => {
  it("returns a window containing the entity for a document over 20,000 chars, and never returns empty", () => {
    const filler = "Lorem ipsum dolor sit amet consectetur adipiscing elit nisi. ".repeat(500);
    const text = `${filler}The Ellendale Flex Campus is a 400 MW data center operated by Applied Digital.${filler}`;
    expect(text.length).toBeGreaterThan(20000);

    const result = windowText(text, "Ellendale Flex Campus", "Ellendale");

    expect(result.mode).toBe("windowed");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain("ellendale");
  });

  it("falls back to a non-empty head slice when no distinctive token appears in a long doc", () => {
    const filler = "word ".repeat(6000);
    expect(filler.length).toBeGreaterThan(20000);

    const result = windowText(filler, "Nonexistent Facility Name", "Nowhere");

    expect(result.mode).toBe("head-fallback");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("passes short documents through unchanged", () => {
    const short = "A short page about a 40 MW facility.";
    expect(windowText(short, "Some Facility")).toEqual({ text: short, mode: "full", windows: 0 });
  });
});

describe("distinctiveTokens", () => {
  it("drops generic descriptor words and keeps identifying tokens", () => {
    // "mining" and "facility" are dropped as generic descriptor words;
    // "cryptocurrency" is not in the generic set, so it is kept.
    expect(distinctiveTokens("AboutBit Merom Cryptocurrency Mining Facility")).toEqual([
      "aboutbit",
      "merom",
      "cryptocurrency",
    ]);
  });
});

describe("quoteVerbatim", () => {
  it("accepts a line-wrapped quote", () => {
    const page = "The facility has a total capacity\nof 540 MW once fully built.";
    expect(quoteVerbatim("total capacity of 540 MW", page)).toBe(true);
  });

  it("accepts a quote stitched from two non-adjacent sentences", () => {
    const page =
      "The Ellendale campus reached commercial operation in March 2025. Unrelated filler text about zoning approvals goes here. It draws power from a dedicated 345 kV substation nearby.";
    const stitchedQuote =
      "The Ellendale campus reached commercial operation in March 2025. It draws power from a dedicated 345 kV substation nearby.";
    expect(quoteVerbatim(stitchedQuote, page)).toBe(true);
  });

  it("accepts a punctuation-wrapped quote against the page's plain text (normalization)", () => {
    const page = "Total capacity is rated at 540 MW for phase one.";
    expect(quoteVerbatim('"540 MW"', page)).toBe(true);
  });

  it("rejects a fabricated span that never appears on the page", () => {
    const page = "Total capacity is rated at 540 MW for phase one.";
    expect(quoteVerbatim("total capacity is rated at 9999 MW", page)).toBe(false);
  });
});

describe("quoteSupportsValue", () => {
  const page =
    "The site is rated at approximately 48 MW today, with a longer-term buildout target of about 1GW+ of capacity. " +
    "Utility filings list a nameplate rating of Capacity 1,000 kW for the auxiliary substation. " +
    "A separate press release simply states 60 without units, and another cites 180 MW+ for an unrelated project.";

  it("accepts '~48 MW' for value 48", () => {
    expect(quoteSupportsValue("~48 MW", 48, page)).toBe(true);
  });

  it("accepts '1GW+' for value 1000 (GW -> MW conversion)", () => {
    expect(quoteSupportsValue("1GW+", 1000, page)).toBe(true);
  });

  it("accepts 'Capacity 1,000 kW' for value 1 (kW -> MW conversion)", () => {
    expect(quoteSupportsValue("Capacity 1,000 kW", 1, page)).toBe(true);
  });

  it("rejects a bare number with no unit", () => {
    expect(quoteSupportsValue("60", 60, page)).toBe(false);
  });

  it("rejects a quote whose value does not reconcile with the extracted number", () => {
    expect(quoteSupportsValue("180 MW+", 999, page)).toBe(false);
  });
});

describe("toEnrichmentIntents", () => {
  const facility = makeFacility();
  const source = facility.sources[0];
  const otherSource = { url: "https://example.com/other-source", label: "Filing", retrievedAt: "2026-01-02", kind: "filing" as const };
  const baseOpts = { runId: "test-run", discoveredAt: "2026-08-15T00:00:00.000Z", date: "2026-08-15" };

  it("returns null for an empty accepted list", () => {
    expect(toEnrichmentIntents(facility, [], baseOpts)).toBeNull();
  });

  it("produces an intent whose body parses against enrichmentUpdateIntentSchema", () => {
    const accepted: AcceptedExtraction[] = [
      { field: "capacityMw.operational", value: 36, verbatimQuote: "36 MW", source },
    ];
    const candidate = toEnrichmentIntents(facility, accepted, baseOpts);

    expect(candidate).not.toBeNull();
    const { targetFacilityId, ...intentBody } = candidate!.enrichmentUpdate;
    expect(targetFacilityId).toBe(facility.id);
    const parsed = enrichmentUpdateIntentSchema.safeParse(intentBody);
    expect(parsed.success).toBe(true);
  });

  it("flags a >=500MW capacity extraction on a data_center facility for review", () => {
    const accepted: AcceptedExtraction[] = [
      { field: "capacityMw.planned", value: 600, verbatimQuote: "600 MW planned", source },
    ];
    const candidate = toEnrichmentIntents(facility, accepted, baseOpts);
    expect(candidate?.provenance.note).toContain("REVIEW: >=500MW");
  });

  it("does not flag a capacity extraction under the review threshold", () => {
    const accepted: AcceptedExtraction[] = [
      { field: "capacityMw.operational", value: 36, verbatimQuote: "36 MW", source },
    ];
    const candidate = toEnrichmentIntents(facility, accepted, baseOpts);
    expect(candidate?.provenance.note).not.toContain("REVIEW:");
  });

  it("lists every DISTINCT contributing source, deduped by URL, when fields come from different pages", () => {
    const accepted: AcceptedExtraction[] = [
      { field: "capacityMw.operational", value: 36, verbatimQuote: "36 MW", source },
      { field: "energy.utility", value: "Xcel Energy", verbatimQuote: "served by Xcel Energy", source: otherSource },
      { field: "energy.onSiteGenerationMw", value: 5, verbatimQuote: "5 MW backup", source }, // same as `source` again
    ];
    const candidate = toEnrichmentIntents(facility, accepted, baseOpts);

    expect(candidate?.enrichmentUpdate.sources).toHaveLength(2); // deduped: `source` counted once despite 2 fields
    const urls = candidate?.enrichmentUpdate.sources.map((s) => s.url);
    expect(urls).toContain(source.url);
    expect(urls).toContain(otherSource.url);
    expect(candidate?.provenance.sources).toEqual(urls);

    // The note must say WHICH url backs WHICH value, unambiguously.
    expect(candidate?.provenance.note).toContain(`capacityMw.operational=36 (quote: "36 MW", source: ${source.url})`);
    expect(candidate?.provenance.note).toContain(
      `energy.utility=Xcel Energy (quote: "served by Xcel Energy", source: ${otherSource.url})`
    );
  });
});

// Regression: parseFieldsArg used to silently substitute the FULL field set
// on an unrecognized `--fields` token (e.g. the wrong "capacityOperational"
// form instead of the canonical "capacityMw.operational"), turning a typo
// into a 5x-larger sweep that silently included the two fields the bench
// measured as unsafe to ship. It must now reject unknown tokens instead.
describe("parseFieldsArg", () => {
  it("returns every field when no --fields flag was given at all", () => {
    expect(parseFieldsArg(undefined)).toEqual([...EXTRACTABLE_FIELDS]);
  });

  it("accepts a valid canonical field name", () => {
    expect(parseFieldsArg("capacityMw.operational")).toEqual(["capacityMw.operational"]);
  });

  it("accepts multiple valid canonical field names", () => {
    expect(parseFieldsArg("capacityMw.operational, energy.utility")).toEqual([
      "capacityMw.operational",
      "energy.utility",
    ]);
  });

  it("rejects an unrecognized field name instead of silently substituting the full set", () => {
    expect(() => parseFieldsArg("capacityOperational")).toThrow(/capacityOperational/);
  });

  it("rejects a mix of valid and invalid field names", () => {
    expect(() => parseFieldsArg("capacityMw.operational,capacityOperational")).toThrow(/capacityOperational/);
  });
});

// Regression: a source that fetched `{ ok: true }` but yielded only a
// handful of characters (a JS-rendered page, e.g. an ArcGIS embed) used to be
// treated exactly like a normal successful fetch — it silently proceeded to
// prefilter/extract against near-nothing, converting "we could not read this
// source" into "this source does not state the fact." A too-short fetch must
// now be counted separately (`unreadable`), never folded into `prefiltered`
// or `fetchFailures`, and the model must never be called for it.
describe("runExtract — near-empty fetch guard", () => {
  function makeExtractFacility(id: string): Facility {
    return {
      id,
      name: "Thin Page Facility",
      operator: "Test Operator",
      status: "operational",
      facilityType: "data_center",
      confidence: "confirmed",
      location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
      statusHistory: [],
      sources: [{ url: "https://example.com/thin-page", label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
      lastUpdated: "2026-01-01",
    };
  }

  it("does not treat a fetch far below MIN_READABLE_CHARS as a readable page", async () => {
    const facility = makeExtractFacility("thin-page-facility");
    let ollamaCalls = 0;
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: "short", finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => {
        ollamaCalls++;
        return { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "n/a" } };
      },
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.unreadable).toBe(1);
    expect(summary.prefiltered).toBe(0);
    expect(summary.fetchFailures).toBe(0);
    expect(summary.candidates).toEqual([]);
    expect(ollamaCalls).toBe(0);
  });

  it("still accepts a fetch that clears MIN_READABLE_CHARS", async () => {
    const facility = makeExtractFacility("readable-page-facility");
    const longEnoughText = `The Thin Page Facility is a data center. ${"Filler sentence about the site. ".repeat(20)}`;
    expect(longEnoughText.length).toBeGreaterThanOrEqual(400);

    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: longEnoughText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({ ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "not stated" } }),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.unreadable).toBe(0);
    // "capacityMw.operational" needs a power-unit hint to pass prefilter; the
    // filler text has none, so this should be prefiltered out, not fetched
    // as unreadable — proving the readable-page path was actually taken.
    expect(summary.prefiltered).toBe(1);
  });
});

// Regression: enrichment is fill-missing, so a record with only
// capacityMw.operational set still queues capacityMw.planned as a gap. When a
// page states exactly one capacity figure, the model correctly returns that
// figure for whichever sub-field it was asked about — which used to get
// written into both sub-fields, making a facility look like it has a planned
// expansion equal to its current size when no source says so.
describe("isDuplicateOfRecordedSibling", () => {
  it("flags an extracted planned value that matches the recorded operational value", () => {
    const facility = makeFacility({ capacityMw: { operational: 15 } });
    expect(isDuplicateOfRecordedSibling(facility, "capacityMw.planned", 15)).toBe(true);
  });

  it("does not flag a genuinely different planned value (value-sensitive, not a blanket suppression)", () => {
    const facility = makeFacility({ capacityMw: { operational: 15 } });
    expect(isDuplicateOfRecordedSibling(facility, "capacityMw.planned", 40)).toBe(false);
  });

  it("is symmetric: flags an extracted operational value that matches the recorded planned value", () => {
    const facility = makeFacility({ capacityMw: { planned: 100 } });
    expect(isDuplicateOfRecordedSibling(facility, "capacityMw.operational", 100)).toBe(true);
  });

  it("does not fire when there is no recorded sibling to compare against", () => {
    const facility = makeFacility();
    expect(isDuplicateOfRecordedSibling(facility, "capacityMw.planned", 15)).toBe(false);
  });

  it("never applies to energy.* fields", () => {
    const facility = makeFacility({ energy: { onSiteGenerationMw: 15 } });
    expect(isDuplicateOfRecordedSibling(facility, "energy.onSiteGenerationMw", 15)).toBe(false);
  });
});

describe("runExtract — duplicate-of-recorded-sibling guard", () => {
  function makeDeps(extractedValue: number): RunExtractDeps {
    const quote = `planned capacity of ${extractedValue} MW`;
    const pageText = `The facility has a ${quote}. ${"Filler sentence about the site and its operations. ".repeat(20)}`;
    return {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: extractedValue, verbatimQuote: quote, reasonIfNull: null },
      }),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };
  }

  it("emits no candidate when the extraction merely repeats the recorded operational value", async () => {
    const facility = makeFacility({ id: "duplicate-sibling-facility", capacityMw: { operational: 15 } });

    const summary = await runExtract([facility], { fields: ["capacityMw.planned"], runId: "test-run" }, makeDeps(15));

    expect(summary.duplicateOfSibling).toBe(1);
    expect(summary.candidates).toEqual([]);
  });

  it("emits a candidate when the extracted planned value genuinely differs from the recorded operational value", async () => {
    const facility = makeFacility({ id: "distinct-sibling-facility", capacityMw: { operational: 15 } });

    const summary = await runExtract([facility], { fields: ["capacityMw.planned"], runId: "test-run" }, makeDeps(40));

    expect(summary.duplicateOfSibling).toBe(0);
    expect(summary.candidates).toHaveLength(1);
  });
});

// Guard 1: a facility that is not itself "operational" cannot have an
// operational-capacity figure — this is a contradiction in the record, not a
// judgement call. Real 2026-08-16 audit examples: iren-sweetwater-tx
// (status "under_construction") extracted operational: 1400;
// big-horn-data-hub-hardin-mt (status "cancelled") extracted operational: 100.
describe("isOperationalStatusContradiction", () => {
  it("flags capacityMw.operational for every non-operational status", () => {
    for (const status of ["under_construction", "permitted", "proposed", "cancelled"] as const) {
      const facility = makeFacility({ status });
      expect(isOperationalStatusContradiction(facility, "capacityMw.operational")).toBe(true);
    }
  });

  it("does not flag capacityMw.operational for a genuinely operational facility", () => {
    const facility = makeFacility({ status: "operational" });
    expect(isOperationalStatusContradiction(facility, "capacityMw.operational")).toBe(false);
  });

  it("never flags capacityMw.planned, regardless of status — a proposed/cancelled facility can legitimately have HAD a planned figure", () => {
    for (const status of ["under_construction", "permitted", "proposed", "cancelled", "operational"] as const) {
      const facility = makeFacility({ status });
      expect(isOperationalStatusContradiction(facility, "capacityMw.planned")).toBe(false);
    }
  });

  it("never flags energy.* fields", () => {
    const facility = makeFacility({ status: "cancelled" });
    expect(isOperationalStatusContradiction(facility, "energy.onSiteGenerationMw")).toBe(false);
    expect(isOperationalStatusContradiction(facility, "energy.utility")).toBe(false);
  });
});

describe("runExtract — status/field contradiction guard (Guard 1)", () => {
  function makeStatusDeps(extractedValue: number): RunExtractDeps {
    const quote = `operational capacity of ${extractedValue} MW`;
    const pageText = `The facility has an ${quote}. ${"Filler sentence about the site and its operations. ".repeat(20)}`;
    return {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: extractedValue, verbatimQuote: quote, reasonIfNull: null },
      }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    };
  }

  it.each(["under_construction", "permitted", "proposed", "cancelled"] as const)(
    "rejects an extracted capacityMw.operational when status is %s (statusContradiction, not extracted)",
    async (status) => {
      const facility = makeFacility({ id: `contradiction-${status}`, status });

      const summary = await runExtract(
        [facility],
        { fields: ["capacityMw.operational"], runId: "test-run" },
        makeStatusDeps(100)
      );

      expect(summary.statusContradiction).toBe(1);
      expect(summary.extracted).toBe(0);
      expect(summary.candidates).toEqual([]);
    }
  );

  it("accepts an extracted capacityMw.operational when the facility is genuinely operational (must NOT fire)", async () => {
    const facility = makeFacility({ id: "genuinely-operational", status: "operational" });

    const summary = await runExtract(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      makeStatusDeps(100)
    );

    expect(summary.statusContradiction).toBe(0);
    expect(summary.extracted).toBe(1);
    expect(summary.candidates).toHaveLength(1);
  });

  it("does not fire on an operational power_generation facility (comanche-peak-nuclear shape — keys off status, not facilityType)", async () => {
    const facility: Facility = {
      id: "power-plant-operational",
      name: "Test Nuclear Plant",
      operator: "Test Utility",
      status: "operational",
      facilityType: "power_generation",
      confidence: "confirmed",
      location: { lat: 32, lon: -97, city: "Testville", state: "TX", precision: "exact" },
      statusHistory: [],
      sources: [
        { url: "https://example.com/plant-source", label: "Press release", retrievedAt: "2026-01-01", kind: "press" },
      ],
      lastUpdated: "2026-01-01",
      generation: undefined,
    };

    const summary = await runExtract(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      makeStatusDeps(1200)
    );

    expect(summary.statusContradiction).toBe(0);
    expect(summary.extracted).toBe(1);
    expect(summary.candidates).toHaveLength(1);
  });

  it("does not block a legitimate capacityMw.planned extraction on a non-operational facility (scoped to .operational only)", async () => {
    const facility = makeFacility({ id: "cancelled-but-planned", status: "cancelled" });
    const quote = "planned capacity of 100 MW";
    const pageText = `The facility had a ${quote} before the project was cancelled. ${"Filler sentence about the site. ".repeat(20)}`;
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: quote, reasonIfNull: null } }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    };

    const summary = await runExtract([facility], { fields: ["capacityMw.planned"], runId: "test-run" }, deps);

    expect(summary.statusContradiction).toBe(0);
    expect(summary.extracted).toBe(1);
  });
});

// Guard 2: within a SINGLE facility's extraction, capacityMw.operational and
// capacityMw.planned resolving to the SAME value cannot both be independent
// facts. Unlike isDuplicateOfRecordedSibling (which compares against an
// ALREADY-RECORDED sibling), this fires when NEITHER sub-field was
// previously recorded, so there was no recorded value for that guard to
// compare against, and one ambiguous quote silently filled both gaps. Real
// 2026-08-16 audit examples (8 of 101 candidates, all from a single quote):
// google-haskell-county-tx — "Capacity 640 MW PV + 1.3 GWh BESS" (a solar
// farm + battery spec, not data-centre IT load) filled BOTH fields with 640.
describe("detectSiblingValueCollision", () => {
  const source = {
    url: "https://example.com/source",
    label: "Press release",
    retrievedAt: "2026-01-01",
    kind: "press" as const,
  };

  it("drops both fields when operational and planned resolve to the same value", () => {
    const accepted: AcceptedExtraction[] = [
      { field: "capacityMw.operational", value: 640, verbatimQuote: "Capacity 640 MW PV + 1.3 GWh BESS", source },
      { field: "capacityMw.planned", value: 640, verbatimQuote: "Capacity 640 MW PV + 1.3 GWh BESS", source },
    ];

    const result = detectSiblingValueCollision(accepted);

    expect(result.accepted).toEqual([]);
    expect(result.collidedFields).toEqual(["capacityMw.operational", "capacityMw.planned"]);
  });

  it("keeps both fields when the values genuinely differ (must NOT fire)", () => {
    const accepted: AcceptedExtraction[] = [
      { field: "capacityMw.operational", value: 40, verbatimQuote: "40 MW", source },
      { field: "capacityMw.planned", value: 90, verbatimQuote: "90 MW", source },
    ];

    const result = detectSiblingValueCollision(accepted);

    expect(result.accepted).toEqual(accepted);
    expect(result.collidedFields).toEqual([]);
  });

  it("does not fire when only one of the two capacity fields was extracted", () => {
    const accepted: AcceptedExtraction[] = [{ field: "capacityMw.operational", value: 40, verbatimQuote: "40 MW", source }];

    const result = detectSiblingValueCollision(accepted);

    expect(result.accepted).toEqual(accepted);
    expect(result.collidedFields).toEqual([]);
  });

  it("leaves unrelated energy.* extractions untouched even when a collision fires", () => {
    const accepted: AcceptedExtraction[] = [
      { field: "capacityMw.operational", value: 60, verbatimQuote: "60 MW", source },
      { field: "capacityMw.planned", value: 60, verbatimQuote: "60 MW", source },
      { field: "energy.utility", value: "Xcel Energy", verbatimQuote: "served by Xcel Energy", source },
    ];

    const result = detectSiblingValueCollision(accepted);

    expect(result.accepted).toEqual([
      { field: "energy.utility", value: "Xcel Energy", verbatimQuote: "served by Xcel Energy", source },
    ]);
    expect(result.collidedFields).toEqual(["capacityMw.operational", "capacityMw.planned"]);
  });
});

describe("runExtract — sibling value collision guard (Guard 2)", () => {
  it("real-shape regression: a single solar+battery quote must not fill both operational and planned with 640", async () => {
    const facility = makeFacility({ id: "google-haskell-county-tx" });
    const quote = "Capacity 640 MW PV + 1.3 GWh BESS";
    const pageText = `The site has a ${quote}. ${"Filler sentence about the site. ".repeat(20)}`;
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 640, verbatimQuote: quote, reasonIfNull: null } }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    };

    const summary = await runExtract(
      [facility],
      { fields: ["capacityMw.operational", "capacityMw.planned"], runId: "test-run" },
      deps
    );

    expect(summary.siblingCollision).toBe(2); // one per field
    expect(summary.extracted).toBe(0);
    expect(summary.candidates).toEqual([]);
  });

  it("does not fire when operational and planned genuinely differ (must NOT fire)", async () => {
    const facility = makeFacility({ id: "distinct-capacity-facility" });
    const pageText = `The facility has an operational capacity of 40 MW and a planned capacity of 90 MW. ${"Filler sentence about the site. ".repeat(20)}`;
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async (opts) => {
        if (opts.userPrompt.includes("CURRENTLY OPERATIONAL")) {
          return { ok: true, data: { value: 40, verbatimQuote: "operational capacity of 40 MW", reasonIfNull: null } };
        }
        return { ok: true, data: { value: 90, verbatimQuote: "planned capacity of 90 MW", reasonIfNull: null } };
      },
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    };

    const summary = await runExtract(
      [facility],
      { fields: ["capacityMw.operational", "capacityMw.planned"], runId: "test-run" },
      deps
    );

    expect(summary.siblingCollision).toBe(0);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]?.enrichmentUpdate.fields.capacityMw).toEqual({ operational: 40, planned: 90 });
  });

  // Regression (code-reviewer finding, 2026-08-16): an earlier version of this
  // guard's log line printed only `facility.id` and `field` — a human could
  // not tell WHAT value was dropped or WHICH source produced it without
  // re-running the extraction, at which point a genuinely correct dropped
  // value (e.g. qts-ashburn-2's real "planned: 75 MW") is unrecoverable. The
  // log line must carry both fields' value, quote, and source — sourced from
  // TWO DIFFERENT cited pages here, proving the guard never assumes a shared
  // source (fields can legitimately be filled from different sources, see
  // defect 4 / `processFacilitySources`).
  it("logs both fields' value, quote, and source when a collision is dropped, even when the two fields came from DIFFERENT sources", async () => {
    const facility: Facility = {
      ...makeFacility({ id: "qts-ashburn-2" }),
      sources: [
        { url: "https://example.com/qts-ashburn-2-planned", label: "Filing", retrievedAt: "2026-01-01", kind: "filing" },
        {
          url: "https://example.com/qts-ashburn-2-operational",
          label: "Press release",
          retrievedAt: "2026-01-01",
          kind: "press",
        },
      ],
    };
    const filler = "Filler sentence about the site and its operations. ".repeat(20);
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        if (url.endsWith("planned")) {
          return { ok: true, text: `The facility has a planned capacity of 75 MW. ${filler}`, finalUrl: url, httpStatus: 200 };
        }
        return { ok: true, text: `The facility has an operational capacity of 75 MW. ${filler}`, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async (opts) => {
        if (opts.userPrompt.includes("CURRENTLY OPERATIONAL")) {
          return { ok: true, data: { value: 75, verbatimQuote: "operational capacity of 75 MW", reasonIfNull: null } };
        }
        return { ok: true, data: { value: 75, verbatimQuote: "planned capacity of 75 MW", reasonIfNull: null } };
      },
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const summary = await runExtract(
        [facility],
        { fields: ["capacityMw.operational", "capacityMw.planned"], runId: "test-run" },
        deps
      );
      expect(summary.siblingCollision).toBe(2);

      const collisionLine = logSpy.mock.calls.map((args) => String(args[0])).find((line) => line.includes("sibling collision"));
      expect(collisionLine).toBeDefined();

      // Recoverable evidence: facility id, both values, both (distinct) verbatim
      // quotes, and both (distinct) source URLs — everything needed to judge
      // the dropped fact by inspection, with no re-run required.
      expect(collisionLine).toContain("qts-ashburn-2");
      expect(collisionLine).toContain("value=75");
      expect(collisionLine).toContain('quote="operational capacity of 75 MW"');
      expect(collisionLine).toContain('quote="planned capacity of 75 MW"');
      expect(collisionLine).toContain("source=https://example.com/qts-ashburn-2-operational");
      expect(collisionLine).toContain("source=https://example.com/qts-ashburn-2-planned");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reconciliation identity holds across a run combining BOTH new guards plus ordinary outcomes", async () => {
    // Each facility needs its OWN source URL — makeFacility() defaults every
    // facility to the same "https://example.com/source", which would collapse
    // the three branches below onto one fetch response. capacityMw.planned is
    // pre-recorded on contradictionFacility so it has exactly ONE gap
    // (operational) — isolates Guard 1's contribution from Guard 2's rather
    // than needing the mock to distinguish fields for this facility.
    const withOwnSource = (facility: Facility, url: string): Facility => ({
      ...facility,
      sources: [{ url, label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
    });
    const contradictionFacility = withOwnSource(
      makeFacility({ id: "combo-contradiction", status: "under_construction", capacityMw: { planned: 999 } }),
      "https://example.com/combo-contradiction"
    );
    const collisionFacility = withOwnSource(
      makeFacility({ id: "combo-collision" }),
      "https://example.com/combo-collision"
    );
    const cleanFacility = withOwnSource(makeFacility({ id: "combo-clean" }), "https://example.com/combo-clean");

    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        const filler = "Filler sentence about the site and its operations. ".repeat(20);
        if (url.includes("combo-contradiction")) {
          return { ok: true, text: `The facility has an operational capacity of 100 MW. ${filler}`, finalUrl: url, httpStatus: 200 };
        }
        if (url.includes("combo-collision")) {
          return { ok: true, text: `The site has a Capacity 200 MW total. ${filler}`, finalUrl: url, httpStatus: 200 };
        }
        return { ok: true, text: `The facility has a planned capacity of 55 MW. ${filler}`, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async (opts) => {
        if (opts.userPrompt.includes("Combo Contradiction")) {
          return { ok: true, data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null } };
        }
        if (opts.userPrompt.includes("Combo Collision")) {
          return { ok: true, data: { value: 200, verbatimQuote: "Capacity 200 MW", reasonIfNull: null } };
        }
        if (opts.userPrompt.includes("CURRENTLY OPERATIONAL")) {
          return { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "not stated for this facility" } };
        }
        return { ok: true, data: { value: 55, verbatimQuote: "planned capacity of 55 MW", reasonIfNull: null } };
      },
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    };

    // Names must embed the branch key used above ("Combo Contradiction" /
    // "Combo Collision") — buildUserPrompt includes facility.name verbatim.
    const facilities: Facility[] = [
      { ...contradictionFacility, name: "Combo Contradiction Corp" },
      { ...collisionFacility, name: "Combo Collision Corp" },
      { ...cleanFacility, name: "Combo Clean Corp" },
    ];

    const summary = await runExtract(
      facilities,
      { fields: ["capacityMw.operational", "capacityMw.planned"], runId: "test-run" },
      deps
    );

    expect(summary.statusContradiction).toBe(1); // combo-contradiction's operational gap
    expect(summary.siblingCollision).toBe(2); // combo-collision's operational + planned gaps
    expect(summary.extracted).toBe(1); // combo-clean's planned gap
    expect(summary.modelNulls).toBe(1); // combo-clean's operational gap (model returned null)
    expect(summary.unclassified).toBe(0);

    const reconciled =
      summary.extracted +
      summary.prefiltered +
      summary.modelNulls +
      summary.modelUnavailable +
      summary.quoteRejected +
      summary.duplicateOfSibling +
      summary.statusContradiction +
      summary.siblingCollision +
      summary.schemaRejected +
      summary.unreadable +
      summary.fetchFailures +
      summary.abortedUnprocessed;
    expect(reconciled).toBe(summary.gapsConsidered);
  });
});

// Regression: `fetchFirstHtmlSource` used to stop reading a facility's cited
// sources the moment ONE of them was readable, regardless of whether it
// actually stated any requested field — measured over the live dataset, this
// opened only ~30% of a gap-facility's cited sources and reported a confident
// "not stated" after reading a fraction of the evidence. Track 5 must now
// read through a facility's cited sources IN ORDER until every requested
// field is filled or sources are exhausted.
describe("runExtract — reads through multiple cited sources (defect 4)", () => {
  function makeMultiSourceFacility(id: string, urls: string[]): Facility {
    return {
      id,
      name: "Multi Source Facility",
      operator: "Test Operator",
      status: "operational",
      facilityType: "data_center",
      confidence: "confirmed",
      location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
      statusHistory: [],
      sources: urls.map((url, i) => ({
        url,
        label: `Source ${i + 1}`,
        retrievedAt: "2026-01-01",
        kind: "press" as const,
      })),
      lastUpdated: "2026-01-01",
    };
  }

  it("reads a third source when neither of the first two states the requested field", async () => {
    const facility = makeMultiSourceFacility("third-source-facility", [
      "https://example.com/source-1",
      "https://example.com/source-2",
      "https://example.com/source-3",
    ]);
    const noMentionPage = `This page discusses site history and permitting only. ${"Filler sentence with no power figures at all. ".repeat(20)}`;
    const pageWithCapacity = `The facility has an operational capacity of 22 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    let fetchCalls = 0;
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        fetchCalls++;
        const text = url.endsWith("source-3") ? pageWithCapacity : noMentionPage;
        return { ok: true, text, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 22, verbatimQuote: "operational capacity of 22 MW", reasonIfNull: null },
      }),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(fetchCalls).toBe(3); // all three sources had to be read
    expect(summary.extracted).toBe(1);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]?.enrichmentUpdate.sources[0]?.url).toBe("https://example.com/source-3");
  });

  it("does not fetch sources 2 and 3 once every requested field is already filled by source 1 (early exit)", async () => {
    const facility = makeMultiSourceFacility("early-exit-facility", [
      "https://example.com/source-1",
      "https://example.com/source-2",
      "https://example.com/source-3",
    ]);
    const pageWithEverything = `The facility has an operational capacity of 22 MW and is served by Xcel Energy. ${"Filler sentence about the site. ".repeat(20)}`;

    let fetchCalls = 0;
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        fetchCalls++;
        return { ok: true, text: pageWithEverything, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async (callOpts) => {
        // buildUserPrompt embeds the field description; branch on it so both
        // requested fields resolve correctly from the SAME stubbed page.
        if (callOpts.userPrompt.includes("utility company")) {
          return {
            ok: true,
            data: { value: "Xcel Energy", verbatimQuote: "served by Xcel Energy", reasonIfNull: null },
          };
        }
        return { ok: true, data: { value: 22, verbatimQuote: "operational capacity of 22 MW", reasonIfNull: null } };
      },
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract(
      [facility],
      { fields: ["capacityMw.operational", "energy.utility"], runId: "test-run" },
      deps
    );

    expect(fetchCalls).toBe(1); // sources 2 and 3 were never fetched
    expect(summary.extracted).toBe(2);
  });

  it("counts a field prefiltered on source 1 but extracted from source 2 as extracted, not prefiltered", async () => {
    const facility = makeMultiSourceFacility("prefilter-then-extract-facility", [
      "https://example.com/source-1",
      "https://example.com/source-2",
    ]);
    const noCapacityMention = `This page discusses zoning history only. ${"Filler sentence with no power figures at all. ".repeat(20)}`;
    const withCapacity = `The facility has a planned capacity of 18 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        const text = url.endsWith("source-2") ? withCapacity : noCapacityMention;
        return { ok: true, text, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 18, verbatimQuote: "planned capacity of 18 MW", reasonIfNull: null },
      }),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract([facility], { fields: ["capacityMw.planned"], runId: "test-run" }, deps);

    expect(summary.prefiltered).toBe(0);
    expect(summary.extracted).toBe(1);
    expect(summary.candidates).toHaveLength(1);
  });
});

// Regression: `unreadable`/`fetchFailures` used to increment ONCE PER
// FACILITY even though `gapsConsidered` is a PER-FIELD count — a facility
// with 2 requested fields and no readable source landed 1 field in
// `unreadable`/`fetchFailures` and the other field in NO bucket at all, so
// the counters silently under-reported. They must reconcile: every gap ends
// up in exactly one outcome bucket.
describe("runExtract — unreadable/fetchFailures reconcile per field, not per facility (defect 5)", () => {
  function makeSingleSourceFacility(
    id: string,
    name: string,
    url: string,
    overrides: { capacityMw?: Facility["capacityMw"] } = {}
  ): Facility {
    return {
      id,
      name,
      operator: "Test Operator",
      status: "operational",
      facilityType: "data_center",
      confidence: "confirmed",
      location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
      statusHistory: [],
      sources: [{ url, label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
      lastUpdated: "2026-01-01",
      capacityMw: overrides.capacityMw,
    };
  }

  it("counts `unreadable` once per requested field on a multi-field facility, not once for the facility", async () => {
    const facility = makeSingleSourceFacility("thin-multi-field-facility", "Thin Multi Field Corp", "https://example.com/thin");
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: "short", finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({ ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "n/a" } }),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract(
      [facility],
      { fields: ["capacityMw.planned", "capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.gapsConsidered).toBe(2);
    expect(summary.unreadable).toBe(2);
  });

  it("counts `fetchFailures` once per requested field on a multi-field facility, not once for the facility", async () => {
    const facility = makeSingleSourceFacility(
      "unfetchable-multi-field-facility",
      "Unfetchable Multi Field Corp",
      "https://example.com/unfetchable"
    );
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "network_error" }),
      callOllamaImpl: async () => ({ ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "n/a" } }),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract(
      [facility],
      { fields: ["capacityMw.planned", "capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.gapsConsidered).toBe(2);
    expect(summary.fetchFailures).toBe(2);
  });

  it("standing invariant: every outcome counter sums to gapsConsidered across a multi-facility, multi-field run", async () => {
    const longFiller = "Filler sentence with no power figures at all. ".repeat(20);

    const fetchFailFacility = makeSingleSourceFacility("f1-fetch-fail", "Fetch Fail Corp", "https://example.com/f1");
    const unreadableFacility = makeSingleSourceFacility("f2-unreadable", "Unreadable Corp", "https://example.com/f2", {
      capacityMw: { operational: 99 },
    });
    const prefilteredFacility = makeSingleSourceFacility("f3-prefiltered", "Prefiltered Corp", "https://example.com/f3", {
      capacityMw: { operational: 99 },
    });
    const modelNullFacility = makeSingleSourceFacility("f4-model-null", "Model Null Corp", "https://example.com/f4", {
      capacityMw: { operational: 99 },
    });
    const quoteRejectedFacility = makeSingleSourceFacility(
      "f5-quote-rejected",
      "Quote Rejected Corp",
      "https://example.com/f5",
      { capacityMw: { operational: 99 } }
    );
    const duplicateFacility = makeSingleSourceFacility("f6-duplicate", "Duplicate Sibling Corp", "https://example.com/f6", {
      capacityMw: { operational: 15 },
    });
    const extractedFacility = makeSingleSourceFacility("f7-extracted", "Extracted Corp", "https://example.com/f7", {
      capacityMw: { operational: 99 },
    });
    // Defect 6's vehicle: `0` clears the quote gate (it genuinely reconciles
    // with a "0 MW" quote) but fails enrichmentUpdateIntentSchema's
    // `capacityMwSchema.strict()` `.positive()` constraint — this field must
    // land in `schemaRejected`, NOT `extracted`.
    const schemaRejectedFacility = makeSingleSourceFacility(
      "f8-schema-rejected",
      "Schema Rejected Corp",
      "https://example.com/f8",
      { capacityMw: { operational: 99 } }
    );

    const pageTextByUrl: Record<string, string> = {
      "https://example.com/f2": "short",
      "https://example.com/f3": `No numbers here at all. ${longFiller}`,
      "https://example.com/f4": `The facility has a planned capacity of 15 MW. ${longFiller}`,
      "https://example.com/f5": `The facility has a planned capacity of 15 MW. ${longFiller}`,
      "https://example.com/f6": `The facility has a planned capacity of 15 MW. ${longFiller}`,
      "https://example.com/f7": `The facility has a planned capacity of 22 MW. ${longFiller}`,
      "https://example.com/f8": `The facility currently has a planned capacity of 0 MW pending approval. ${longFiller}`,
    };

    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        if (url === "https://example.com/f1") return { ok: false, reason: "network_error" };
        return { ok: true, text: pageTextByUrl[url], finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async (callOpts) => {
        if (callOpts.userPrompt.includes("Model Null Corp")) {
          return { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "not stated for this facility" } };
        }
        if (callOpts.userPrompt.includes("Quote Rejected Corp")) {
          // Neither this value nor this quote appears verbatim on f5's page
          // (which only ever mentions 15 MW) — must be rejected by the quote
          // gate, not accepted on trust.
          return { ok: true, data: { value: 999, verbatimQuote: "999 MW", reasonIfNull: null } };
        }
        if (callOpts.userPrompt.includes("Duplicate Sibling Corp")) {
          return { ok: true, data: { value: 15, verbatimQuote: "planned capacity of 15 MW", reasonIfNull: null } };
        }
        if (callOpts.userPrompt.includes("Extracted Corp")) {
          return { ok: true, data: { value: 22, verbatimQuote: "planned capacity of 22 MW", reasonIfNull: null } };
        }
        if (callOpts.userPrompt.includes("Schema Rejected Corp")) {
          return { ok: true, data: { value: 0, verbatimQuote: "planned capacity of 0 MW", reasonIfNull: null } };
        }
        return { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "unused in this test" } };
      },
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    const summary = await runExtract(
      [
        fetchFailFacility, // capacityMw entirely unset -> both fields are gaps -> 2 gaps, both fetchFailures
        unreadableFacility, // 1 gap (planned) -> unreadable
        prefilteredFacility, // 1 gap (planned) -> prefiltered
        modelNullFacility, // 1 gap (planned) -> modelNulls
        quoteRejectedFacility, // 1 gap (planned) -> quoteRejected
        duplicateFacility, // 1 gap (planned) -> duplicateOfSibling
        extractedFacility, // 1 gap (planned) -> extracted
        schemaRejectedFacility, // 1 gap (planned) -> schemaRejected (clears quote gate, fails .positive())
      ],
      { fields: ["capacityMw.planned", "capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.gapsConsidered).toBe(9);
    expect(summary.fetchFailures).toBe(2);
    expect(summary.unreadable).toBe(1);
    expect(summary.prefiltered).toBe(1);
    expect(summary.modelNulls).toBe(1);
    expect(summary.quoteRejected).toBe(1);
    expect(summary.duplicateOfSibling).toBe(1);
    // f8's `0` clears the quote gate but fails schema validation — it must
    // contribute to `schemaRejected`, and `extracted` must stay at 1 (f7
    // only), never double-counting f8 into both buckets.
    expect(summary.extracted).toBe(1);
    expect(summary.schemaRejected).toBe(1);
    expect(summary.candidates).toHaveLength(1); // only f7's candidate — f8's was discarded

    // The standing invariant: every gap lands in EXACTLY one outcome bucket.
    // `modelUnavailable` is included even though this scenario never
    // exercises it (stays 0) — a complete reconciliation must hold whichever
    // buckets happen to be non-zero, not just the ones a given test hits.
    const reconciled =
      summary.extracted +
      summary.prefiltered +
      summary.modelNulls +
      summary.modelUnavailable +
      summary.quoteRejected +
      summary.duplicateOfSibling +
      summary.schemaRejected +
      summary.unreadable +
      summary.fetchFailures;
    expect(reconciled).toBe(summary.gapsConsidered);
  });
});

// Regression (2026-08-16 sweep collapse): a systemic fetch failure partway
// through a real sweep made ~900 consecutive facilities report `fetchFailures`
// and the run still exited 0 — indistinguishable from ordinary dataset link
// rot to anyone reading the summary. `runExtract` must abort loudly (surfaced
// via a RETURNED summary's `aborted`/`abortReason` — never a thrown error;
// see `CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD` and `runExtract`'s "ABORT
// design" doc-comments for why a throw is wrong here) once total fetch
// failure runs unbroken across CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD
// facilities.
describe("runExtract — aborts loudly on a consecutive total-fetch-failure streak (systemic collapse guard)", () => {
  function makeUnfetchableFacility(id: string): Facility {
    return {
      id,
      name: `Facility ${id}`,
      operator: "Test Operator",
      status: "operational",
      facilityType: "data_center",
      confidence: "confirmed",
      location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
      statusHistory: [],
      sources: [{ url: `https://example.com/${id}`, label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
      lastUpdated: "2026-01-01",
    };
  }

  /** A facility whose single source fetches fine and yields a clean,
   * extractable candidate — used to prove real work survives an abort. */
  function makeGoodFacility(id: string): Facility {
    return {
      id,
      name: `Good Facility ${id}`,
      operator: "Test Operator",
      status: "operational",
      facilityType: "data_center",
      confidence: "confirmed",
      location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
      statusHistory: [],
      sources: [{ url: `https://example.com/good-${id}`, label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
      lastUpdated: "2026-01-01",
    };
  }

  const alwaysFailDeps: RunExtractDeps = {
    fetchPageTextImpl: async () => ({ ok: false, reason: "network_error", errorCode: "ECONNRESET" }),
    callOllamaImpl: async () => ({ ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "unused" } }),
    now: () => new Date("2026-08-16T00:00:00.000Z"),
  };

  it("returns an ABORTED summary (never throws) once the streak reaches CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD", async () => {
    const facilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD }, (_, i) =>
      makeUnfetchableFacility(`unfetchable-${i}`)
    );

    const summary = await runExtract(facilities, { fields: ["capacityMw.operational"], runId: "collapse-test" }, alwaysFailDeps);

    expect(summary.aborted).toBe(true);
    expect(summary.abortReason).toMatch(/ABORTING.*consecutive facilities/i);
    // The TRIGGERING facility's own gap is a real fetchFailures outcome, not
    // an unprocessed one — only facilities never reached at all should ever
    // land in abortedUnprocessed (none here: exactly THRESHOLD were given).
    expect(summary.fetchFailures).toBe(CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD);
    expect(summary.abortedUnprocessed).toBe(0);
    expect(summary.unclassified).toBe(0);
  });

  it("preserves candidates found before the abort — an aborted run must not discard legitimate extracted work", async () => {
    const goodFacilities = [makeGoodFacility("a"), makeGoodFacility("b")];
    const badFacilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD }, (_, i) =>
      makeUnfetchableFacility(`unfetchable-${i}`)
    );

    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        if (url === "https://example.com/good-a") {
          return { ok: true, text: `The facility has a planned capacity of 100 MW. ${"filler ".repeat(100)}`, finalUrl: url, httpStatus: 200 };
        }
        if (url === "https://example.com/good-b") {
          return { ok: true, text: `The facility has a planned capacity of 200 MW. ${"filler ".repeat(100)}`, finalUrl: url, httpStatus: 200 };
        }
        return { ok: false, reason: "network_error", errorCode: "ECONNRESET" };
      },
      callOllamaImpl: async (opts) => {
        if (opts.userPrompt.includes("Good Facility a")) {
          return { ok: true, data: { value: 100, verbatimQuote: "planned capacity of 100 MW", reasonIfNull: null } };
        }
        if (opts.userPrompt.includes("Good Facility b")) {
          return { ok: true, data: { value: 200, verbatimQuote: "planned capacity of 200 MW", reasonIfNull: null } };
        }
        return { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "unused" } };
      },
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    };

    const summary = await runExtract(
      [...goodFacilities, ...badFacilities],
      { fields: ["capacityMw.planned"], runId: "collapse-with-work-test" },
      deps
    );

    expect(summary.aborted).toBe(true);
    // The whole point of this test: the two candidates found BEFORE the
    // abort tripped must still be here — an earlier version of this guard
    // threw, which discarded them.
    expect(summary.candidates).toHaveLength(2);
    expect(summary.candidates.map((c) => c.enrichmentUpdate.targetFacilityId).sort()).toEqual(["a", "b"]);
    expect(summary.extracted).toBe(2);
  });

  it("puts gaps from facilities never reached because of the abort into `abortedUnprocessed`, never `unclassified` — reconciliation identity still holds", async () => {
    const badFacilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD }, (_, i) =>
      makeUnfetchableFacility(`unfetchable-${i}`)
    );
    // These come AFTER the streak that trips the abort — the loop `break`s
    // before ever reaching them, so their gaps must show up as
    // abortedUnprocessed, not silently vanish or land in unclassified.
    const neverReached = [makeGoodFacility("never-reached-1"), makeGoodFacility("never-reached-2")];

    const summary = await runExtract(
      [...badFacilities, ...neverReached],
      { fields: ["capacityMw.planned"], runId: "collapse-with-tail-test" },
      alwaysFailDeps
    );

    expect(summary.aborted).toBe(true);
    expect(summary.fetchFailures).toBe(CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD);
    expect(summary.abortedUnprocessed).toBe(2); // never-reached-1 and never-reached-2, one gap each
    expect(summary.unclassified).toBe(0);

    const reconciled =
      summary.extracted +
      summary.prefiltered +
      summary.modelNulls +
      summary.modelUnavailable +
      summary.quoteRejected +
      summary.duplicateOfSibling +
      summary.schemaRejected +
      summary.unreadable +
      summary.fetchFailures +
      summary.abortedUnprocessed;
    expect(reconciled).toBe(summary.gapsConsidered);
  });

  it("does NOT throw for a streak one short of the threshold — proves the guard fires on the boundary, not eagerly", async () => {
    const facilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeUnfetchableFacility(`unfetchable-${i}`)
    );

    const summary = await runExtract(
      facilities,
      { fields: ["capacityMw.operational"], runId: "near-collapse-test" },
      alwaysFailDeps
    );
    expect(summary.fetchFailures).toBe(CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1);
    expect(summary.aborted).toBe(false);
    expect(summary.abortReason).toBeNull();
  });

  it("resets the streak on any facility that reads at least one source (even a merely thin/unreadable one)", async () => {
    // THRESHOLD-1 failures, then one facility whose source fetches fine (just
    // too thin to use), then THRESHOLD-1 more failures — never an unbroken
    // run of THRESHOLD, so this must complete normally.
    const before = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeUnfetchableFacility(`before-${i}`)
    );
    const resetFacility = makeUnfetchableFacility("reset-facility");
    const after = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeUnfetchableFacility(`after-${i}`)
    );

    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        if (url === "https://example.com/reset-facility") {
          return { ok: true, text: "short", finalUrl: url, httpStatus: 200 }; // thin, but a real fetch
        }
        return { ok: false, reason: "network_error", errorCode: "ECONNRESET" };
      },
      callOllamaImpl: alwaysFailDeps.callOllamaImpl,
      now: alwaysFailDeps.now,
    };

    const summary = await runExtract(
      [...before, resetFacility, ...after],
      { fields: ["capacityMw.operational"], runId: "reset-test" },
      deps
    );
    expect(summary.fetchFailures).toBe(2 * (CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1));
    expect(summary.unreadable).toBe(1);
    expect(summary.aborted).toBe(false);
    expect(summary.abortReason).toBeNull();
  });
});

// Regression: a REAL 100-gap live run appeared to show `sum=95` against
// `gapsConsidered=100` — later confirmed to be a stale pre-defect-5 log
// artifact, not a real bug (retracted). Kept anyway because it combines
// exactly the shapes most likely to strand a gap in future edits: a facility
// with ZERO usable sources, a facility whose fields are all filled from
// source 1 (early exit — later sources never fetched), a facility whose
// SECOND field is cut off by `--limit` (so it never enters `gaps` at all,
// and must NOT appear in `gapsConsidered` either — while its SURVIVING field
// must still be correctly classified, not merely implied by an aggregate sum
// that could mask a compensating error), and a facility with one field
// filled and the other not.
describe("runExtract — combined real-shape edge cases reconcile (defect 7, retracted but kept as a regression guard)", () => {
  function makeEdgeCaseFacility(id: string, name: string, sources: Facility["sources"]): Facility {
    return {
      id,
      name,
      operator: "Op",
      status: "operational",
      facilityType: "data_center",
      confidence: "confirmed",
      location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
      statusHistory: [],
      sources,
      lastUpdated: "2026-01-01",
    };
  }

  function source(url: string): Facility["sources"][number] {
    return { url, label: "Source", retrievedAt: "2026-01-01", kind: "press" };
  }

  it("reconciles across a zero-source facility, an early-exit facility, a limit-truncated facility, and a partial-fill facility together", async () => {
    const zeroSourceFacility = makeEdgeCaseFacility("zero-source", "Zero Source Corp", []);
    const earlyExitFacility = makeEdgeCaseFacility("early-exit", "Early Exit Corp", [
      source("https://example.com/early-exit-s0"),
      source("https://example.com/early-exit-s1"),
      source("https://example.com/early-exit-s2"),
    ]);
    // Passed BEFORE limitCutFacility so its gaps (both fields) survive the
    // slice fully — only limitCutFacility's SECOND gap gets truncated.
    const partialFillFacility = makeEdgeCaseFacility("partial-fill", "Partial Fill Corp", [
      source("https://example.com/partial-fill-s0"),
    ]);
    const limitCutFacility = makeEdgeCaseFacility("limit-cut", "Limit Cut Corp", [
      source("https://example.com/limit-cut-s0"),
    ]);

    const fetchedUrls: string[] = [];
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        fetchedUrls.push(url);
        if (url === "https://example.com/early-exit-s0") {
          return {
            ok: true,
            text: `The facility has a planned capacity of 50 MW and an operational capacity of 40 MW. ${"Filler text about the site. ".repeat(20)}`,
            finalUrl: url,
            httpStatus: 200,
          };
        }
        if (url === "https://example.com/partial-fill-s0") {
          return {
            ok: true,
            text: `The facility has a planned capacity of 33 MW. ${"Filler text about the site. ".repeat(20)}`,
            finalUrl: url,
            httpStatus: 200,
          };
        }
        if (url === "https://example.com/limit-cut-s0") {
          return {
            ok: true,
            text: `The facility has a planned capacity of 77 MW. ${"Filler text about the site. ".repeat(20)}`,
            finalUrl: url,
            httpStatus: 200,
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      callOllamaImpl: async (callOpts) => {
        if (callOpts.userPrompt.includes("Early Exit Corp")) {
          if (callOpts.userPrompt.includes("CURRENTLY OPERATIONAL")) {
            return { ok: true, data: { value: 40, verbatimQuote: "operational capacity of 40 MW", reasonIfNull: null } };
          }
          return { ok: true, data: { value: 50, verbatimQuote: "planned capacity of 50 MW", reasonIfNull: null } };
        }
        if (callOpts.userPrompt.includes("Partial Fill Corp")) {
          if (callOpts.userPrompt.includes("CURRENTLY OPERATIONAL")) {
            return { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "not stated for this facility" } };
          }
          return { ok: true, data: { value: 33, verbatimQuote: "planned capacity of 33 MW", reasonIfNull: null } };
        }
        if (callOpts.userPrompt.includes("Limit Cut Corp")) {
          return { ok: true, data: { value: 77, verbatimQuote: "planned capacity of 77 MW", reasonIfNull: null } };
        }
        throw new Error("unexpected callOllamaImpl invocation");
      },
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    };

    // gaps (before --limit), 2 fields each: zero(0,1) early(2,3) partial(4,5)
    // limitCut(6,7) — limit=7 keeps everything through limitCut's FIRST field
    // (index 6) and cuts off its second (index 7, "capacityMw.operational").
    const summary = await runExtract(
      [zeroSourceFacility, earlyExitFacility, partialFillFacility, limitCutFacility],
      { fields: ["capacityMw.planned", "capacityMw.operational"], runId: "test-run", limit: 7 },
      deps
    );

    expect(summary.gapsConsidered).toBe(7); // limitCut's "operational" gap never entered the pool at all
    expect(summary.fetchFailures).toBe(2); // zero-source facility, both fields
    expect(summary.extracted).toBe(4); // early(2) + partial-planned(1) + limitCut-planned(1)
    expect(summary.modelNulls).toBe(1); // partial-operational
    expect(summary.unclassified).toBe(0);

    // The SURVIVING field on the limit-truncated facility must be classified
    // precisely, not merely implied by the aggregate `extracted` total (which
    // could stay correct even if this specific field were dropped while some
    // other field were double-counted). Assert its actual emitted candidate.
    const limitCutCandidate = summary.candidates.find((c) => c.enrichmentUpdate.targetFacilityId === "limit-cut");
    expect(limitCutCandidate).toBeDefined();
    expect(limitCutCandidate?.enrichmentUpdate.fields.capacityMw?.planned).toBe(77);
    // The truncated field was never even requested for this facility — it
    // must not appear in the candidate at all (not just "not extracted").
    expect(limitCutCandidate?.enrichmentUpdate.fields.capacityMw?.operational).toBeUndefined();

    // Early exit: source1/source2 must NEVER be fetched once source0 filled
    // both of earlyExitFacility's fields.
    expect(fetchedUrls).not.toContain("https://example.com/early-exit-s1");
    expect(fetchedUrls).not.toContain("https://example.com/early-exit-s2");
    // Zero-source facility: fetchPageTextImpl must never be called for it at all.
    expect(fetchedUrls.some((u) => u.includes("zero-source"))).toBe(false);

    const reconciled =
      summary.extracted +
      summary.prefiltered +
      summary.modelNulls +
      summary.modelUnavailable +
      summary.quoteRejected +
      summary.duplicateOfSibling +
      summary.schemaRejected +
      summary.unreadable +
      summary.fetchFailures +
      summary.unclassified;
    expect(reconciled).toBe(summary.gapsConsidered);
  });
});

// F2: a facility's cited sources used to be read in raw array order with no
// source-kind preference, so whichever source happened to be cited FIRST won
// every field — a press release's paraphrase of an engineering detail can be
// wrong in ways the underlying primary document isn't (novva-mesa-az: a
// press release said "water-free air-cooling"; the City of Mesa filing it
// paraphrased said "closed-loop water cooling"). `sortSourcesPrimaryFirst`
// reorders primary-document kinds (permit, filing, iso_queue, subsidy) ahead
// of secondary ones (press, osm, other) before `processFacilitySources`
// iterates them.
describe("sortSourcesPrimaryFirst", () => {
  it("moves primary-kind sources ahead of secondary-kind sources", () => {
    const sources: Source[] = [
      { url: "https://example.com/a-press", label: "A", retrievedAt: "2026-01-01", kind: "press" },
      { url: "https://example.com/b-permit", label: "B", retrievedAt: "2026-01-01", kind: "permit" },
      { url: "https://example.com/c-osm", label: "C", retrievedAt: "2026-01-01", kind: "osm" },
      { url: "https://example.com/d-filing", label: "D", retrievedAt: "2026-01-01", kind: "filing" },
    ];

    expect(sortSourcesPrimaryFirst(sources).map((s) => s.url)).toEqual([
      "https://example.com/b-permit",
      "https://example.com/d-filing",
      "https://example.com/a-press",
      "https://example.com/c-osm",
    ]);
  });

  it("preserves relative order within each rank group (stable reorder)", () => {
    const sources: Source[] = [
      { url: "https://example.com/press-1", label: "P1", retrievedAt: "2026-01-01", kind: "press" },
      { url: "https://example.com/permit-1", label: "Permit1", retrievedAt: "2026-01-01", kind: "permit" },
      { url: "https://example.com/press-2", label: "P2", retrievedAt: "2026-01-01", kind: "press" },
      { url: "https://example.com/permit-2", label: "Permit2", retrievedAt: "2026-01-01", kind: "permit" },
    ];

    expect(sortSourcesPrimaryFirst(sources).map((s) => s.url)).toEqual([
      "https://example.com/permit-1",
      "https://example.com/permit-2",
      "https://example.com/press-1",
      "https://example.com/press-2",
    ]);
  });

  it("returns a new array and does not mutate the input", () => {
    const sources: Source[] = [
      { url: "https://example.com/press", label: "P", retrievedAt: "2026-01-01", kind: "press" },
      { url: "https://example.com/permit", label: "Permit", retrievedAt: "2026-01-01", kind: "permit" },
    ];
    const original = [...sources];

    const reordered = sortSourcesPrimaryFirst(sources);

    expect(sources).toEqual(original); // input untouched
    expect(reordered).not.toBe(sources); // a distinct array was returned
  });
});

describe("runExtract — primary documents outrank press for field extraction (F2)", () => {
  it("takes the permit's value over a differing press value for the same field (novva-mesa-az shape)", async () => {
    const facility: Facility = {
      ...makeFacility({ id: "novva-mesa-az-like" }),
      sources: [
        { url: "https://example.com/press-release", label: "Press release", retrievedAt: "2026-01-01", kind: "press" },
        { url: "https://example.com/city-filing", label: "City of Mesa filing", retrievedAt: "2026-01-01", kind: "permit" },
      ],
    };
    const filler = "Filler sentence about the site and its operations. ".repeat(20);
    const pressText = `The facility has an operational capacity of 50 MW. ${filler}`;
    const permitText = `The facility has an operational capacity of 75 MW. ${filler}`;

    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => {
        const text = url.endsWith("city-filing") ? permitText : pressText;
        return { ok: true, text, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async (opts) => {
        // Branch on the embedded page text (buildUserPrompt inlines it
        // verbatim) so each source resolves to its OWN stated value.
        if (opts.userPrompt.includes("75 MW")) {
          return { ok: true, data: { value: 75, verbatimQuote: "operational capacity of 75 MW", reasonIfNull: null } };
        }
        return { ok: true, data: { value: 50, verbatimQuote: "operational capacity of 50 MW", reasonIfNull: null } };
      },
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    };

    const summary = await runExtract([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.extracted).toBe(1);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]?.enrichmentUpdate.fields.capacityMw?.operational).toBe(75);
    expect(summary.candidates[0]?.enrichmentUpdate.sources[0]?.url).toBe("https://example.com/city-filing");
  });

  it("still extracts normally when a facility cites only press sources (no primary-doc regression)", async () => {
    const facility: Facility = {
      ...makeFacility({ id: "press-only-facility" }),
      sources: [
        { url: "https://example.com/press-a", label: "Press A", retrievedAt: "2026-01-01", kind: "press" },
        { url: "https://example.com/press-b", label: "Press B", retrievedAt: "2026-01-01", kind: "press" },
      ],
    };
    const filler = "Filler sentence about the site and its operations. ".repeat(20);
    const deps: RunExtractDeps = {
      fetchPageTextImpl: async (url) => ({
        ok: true,
        text: `The facility has an operational capacity of 40 MW. ${filler}`,
        finalUrl: url,
        httpStatus: 200,
      }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 40, verbatimQuote: "operational capacity of 40 MW", reasonIfNull: null },
      }),
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    };

    const summary = await runExtract([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.extracted).toBe(1);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]?.enrichmentUpdate.fields.capacityMw?.operational).toBe(40);
    // First-cited press source still wins when there is no primary doc to
    // prefer — the reorder is rank-based, not a blanket source-1 penalty.
    expect(summary.candidates[0]?.enrichmentUpdate.sources[0]?.url).toBe("https://example.com/press-a");
  });
});
