import { describe, it, expect } from "vitest";

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
  EXTRACTABLE_FIELDS,
  type AcceptedExtraction,
  type RunExtractDeps,
} from "./extract-fields";
import { enrichmentUpdateIntentSchema } from "../../lib/enrichment-update";
import type { Facility } from "../../lib/schema";

function makeFacility(overrides: {
  id?: string;
  capacityMw?: Facility["capacityMw"];
  energy?: Facility["energy"];
} = {}): Facility {
  return {
    id: overrides.id ?? "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: "operational",
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
