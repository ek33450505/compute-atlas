import { describe, it, expect } from "vitest";

import {
  selectValuesToVerify,
  valuesReconcile,
  runVerify,
  type VerifyFieldsDeps,
} from "./verify-fields";
import { CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD } from "./extract-fields";
import type { Facility } from "../../lib/schema";

function makeFacility(overrides: {
  id?: string;
  capacityMw?: Facility["capacityMw"];
  energy?: Facility["energy"];
  sources?: Facility["sources"];
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
    sources: overrides.sources ?? [
      { url: "https://example.com/source", label: "Press release", retrievedAt: "2026-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    capacityMw: overrides.capacityMw,
    energy: overrides.energy,
  };
}

function fixedNow(): Date {
  return new Date("2026-08-16T00:00:00.000Z");
}

// ============================================================================
// selectValuesToVerify — the mirror image of extract-fields.ts's selectGaps
// ============================================================================

describe("selectValuesToVerify", () => {
  it("only returns fields that currently carry a recorded value", () => {
    const withCapacity = makeFacility({ id: "with-capacity", capacityMw: { operational: 100 } });
    const withoutCapacity = makeFacility({ id: "without-capacity" });

    const checks = selectValuesToVerify([withCapacity, withoutCapacity], ["capacityMw.operational", "energy.source"]);

    expect(checks).toEqual([{ facility: withCapacity, field: "capacityMw.operational", recordedValue: 100 }]);
  });

  it("returns no checks when no requested field is set on any facility", () => {
    const empty = makeFacility({ id: "empty" });
    expect(selectValuesToVerify([empty], ["capacityMw.operational", "energy.source"])).toEqual([]);
  });

  it("returns one check per recorded field, in facility-then-field order", () => {
    const facility = makeFacility({
      id: "both-set",
      capacityMw: { operational: 50, planned: 80 },
      energy: { source: "grid" },
    });

    const checks = selectValuesToVerify([facility], ["capacityMw.operational", "capacityMw.planned", "energy.source"]);

    expect(checks).toEqual([
      { facility, field: "capacityMw.operational", recordedValue: 50 },
      { facility, field: "capacityMw.planned", recordedValue: 80 },
      { facility, field: "energy.source", recordedValue: "grid" },
    ]);
  });
});

// ============================================================================
// valuesReconcile — the 5% tolerance rule (numeric) and normalized string
// equality (energy.source / energy.utility)
// ============================================================================

describe("valuesReconcile", () => {
  it("treats numeric values within 5% relative tolerance as the same fact", () => {
    expect(valuesReconcile("capacityMw.operational", 100, 103)).toBe(true);
    expect(valuesReconcile("capacityMw.operational", 100, 97)).toBe(true);
  });

  it("treats numeric values outside 5% relative tolerance as a disagreement", () => {
    expect(valuesReconcile("capacityMw.operational", 100, 150)).toBe(false);
    expect(valuesReconcile("capacityMw.operational", 100, 40)).toBe(false);
  });

  it("compares energy.source case-insensitively", () => {
    expect(valuesReconcile("energy.source", "grid", "GRID")).toBe(true);
    expect(valuesReconcile("energy.source", "grid", "solar")).toBe(false);
  });

  it("compares energy.utility with whitespace-collapsed, case-insensitive equality", () => {
    expect(valuesReconcile("energy.utility", "Xcel Energy", "  xcel   energy  ")).toBe(true);
    expect(valuesReconcile("energy.utility", "Xcel Energy", "Duke Energy")).toBe(false);
  });
});

// ============================================================================
// runVerify — the five-outcome classification, read all sources, quote gate
// on the model's own answer, reconciliation identity, and the abort guard
// ============================================================================

describe("runVerify — confirmed", () => {
  it("classifies a source-stated value within tolerance as confirmed", async () => {
    const facility = makeFacility({ id: "confirmed-facility", capacityMw: { operational: 100 } });
    const pageText = `The facility has an operational capacity of 102 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 102, verbatimQuote: "operational capacity of 102 MW", reasonIfNull: null },
      }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.confirmed).toBe(1);
    expect(summary.disagreements).toBe(0);
    expect(summary.results[0]?.outcome).toBe("confirmed");
    expect(summary.results[0]?.sourceStatedValue).toBe(102);
  });
});

describe("runVerify — disagreement (THE PAYLOAD)", () => {
  it("classifies a source-stated value outside tolerance as a disagreement, with the recorded value, source-stated value, quote, and URL all present", async () => {
    const facility = makeFacility({ id: "disagreement-facility", capacityMw: { operational: 100 } });
    const pageText = `The facility has an operational capacity of 250 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 250, verbatimQuote: "operational capacity of 250 MW", reasonIfNull: null },
      }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.disagreements).toBe(1);
    expect(summary.confirmed).toBe(0);
    const result = summary.results[0];
    expect(result?.outcome).toBe("disagreement");
    expect(result?.recordedValue).toBe(100);
    expect(result?.sourceStatedValue).toBe(250);
    expect(result?.verbatimQuote).toContain("250 MW");
    expect(result?.sourceUrl).toBe("https://example.com/source");
  });
});

describe("runVerify — unconfirmed (model null) is NEVER counted as a disagreement", () => {
  it("classifies a model null as unconfirmed, not disagreement — the central design constraint of this tool", async () => {
    const facility = makeFacility({ id: "unconfirmed-facility", capacityMw: { operational: 100 } });
    // Passes the prefilter (contains a power-unit mention) but the model
    // determines it does not actually state THIS facility's capacity.
    const pageText = `A nearby unrelated facility has a capacity of 60 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: null, verbatimQuote: null, reasonIfNull: "page describes a different facility" },
      }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.unconfirmed).toBe(1);
    expect(summary.disagreements).toBe(0);
    expect(summary.confirmed).toBe(0);
    expect(summary.results[0]?.outcome).toBe("unconfirmed");
  });
});

describe("runVerify — noMention", () => {
  it("classifies a page with no plausible power mention as noMention without calling the model", async () => {
    const facility = makeFacility({ id: "no-mention-facility", capacityMw: { operational: 100 } });
    const pageText = `This page discusses zoning history and permitting only. ${"Filler sentence with no power figures at all. ".repeat(20)}`;

    let modelCalls = 0;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => {
        modelCalls++;
        return { ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } };
      },
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.noMention).toBe(1);
    expect(modelCalls).toBe(0);
    expect(summary.results[0]?.outcome).toBe("noMention");
  });
});

describe("runVerify — unreachable", () => {
  it("classifies a failed fetch as unreachable", async () => {
    const facility = makeFacility({ id: "unreachable-facility", capacityMw: { operational: 100 } });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "http_error", httpStatus: 404 }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.unreachable).toBe(1);
    expect(summary.results[0]?.outcome).toBe("unreachable");
  });
});

describe("runVerify — quote gate applies to the MODEL's own answer", () => {
  it("rejects an ungrounded model value via the quote gate and does NOT raise a false disagreement", async () => {
    const facility = makeFacility({ id: "ungrounded-facility", capacityMw: { operational: 100 } });
    // Contains a power-unit mention (clears the prefilter) but the model's
    // claimed quote below is fabricated — it never appears on this page.
    const pageText = `The facility broke ground with an initial 50 MW substation. ${"Filler sentence about the site. ".repeat(20)}`;

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({
        ok: true,
        data: {
          value: 500,
          verbatimQuote: "the facility's operational capacity is 500 MW", // fabricated — not a real span of pageText
          reasonIfNull: null,
        },
      }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    // A hallucinated 500 MW would be a wildly false disagreement against the
    // correct recorded 100 MW — the worst outcome this tool can produce. The
    // quote gate must catch it and downgrade it to unconfirmed instead.
    expect(summary.disagreements).toBe(0);
    expect(summary.unconfirmed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("unconfirmed");
  });
});

describe("runVerify — reads ALL cited sources, never stops at the first confirmation", () => {
  it("reads a second source even after the first one confirms the recorded value", async () => {
    const facility = makeFacility({
      id: "read-all-facility",
      capacityMw: { operational: 100 },
      sources: [
        { url: "https://example.com/source-1", label: "Source 1", retrievedAt: "2026-01-01", kind: "press" },
        { url: "https://example.com/source-2", label: "Source 2", retrievedAt: "2026-01-01", kind: "press" },
      ],
    });
    const confirmingPage = `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`;
    const contradictingPage = `The facility has an operational capacity of 300 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    let fetchCalls = 0;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        fetchCalls++;
        const text = url.endsWith("source-2") ? contradictingPage : confirmingPage;
        return { ok: true, text, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async (opts) => {
        // Both mock pages state a plain 100/300 MW figure; branch on which
        // page text was embedded in the prompt so each source resolves to
        // its own stated value.
        if (opts.userPrompt.includes("300 MW")) {
          return { ok: true, data: { value: 300, verbatimQuote: "operational capacity of 300 MW", reasonIfNull: null } };
        }
        return { ok: true, data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null } };
      },
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    // Both sources must have been read — an early exit on the first
    // confirmation would have hidden the second source's contradiction.
    expect(fetchCalls).toBe(2);
    expect(summary.sourceChecksAttempted).toBe(2);
    expect(summary.confirmed).toBe(1);
    expect(summary.disagreements).toBe(1);
  });

  it("reports BOTH sources when they disagree with each other (and with the record)", async () => {
    const facility = makeFacility({
      id: "two-sources-disagree",
      capacityMw: { operational: 100 },
      sources: [
        { url: "https://example.com/source-1", label: "Source 1", retrievedAt: "2026-01-01", kind: "press" },
        { url: "https://example.com/source-2", label: "Source 2", retrievedAt: "2026-01-01", kind: "press" },
      ],
    });
    const page1 = `The facility has an operational capacity of 40 MW. ${"Filler sentence about the site. ".repeat(20)}`;
    const page2 = `The facility has an operational capacity of 60 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        const text = url.endsWith("source-2") ? page2 : page1;
        return { ok: true, text, finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async (opts) => {
        if (opts.userPrompt.includes("60 MW")) {
          return { ok: true, data: { value: 60, verbatimQuote: "operational capacity of 60 MW", reasonIfNull: null } };
        }
        return { ok: true, data: { value: 40, verbatimQuote: "operational capacity of 40 MW", reasonIfNull: null } };
      },
      now: fixedNow,
    };

    const summary = await runVerify(
      [facility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.disagreements).toBe(2);
    const stated = summary.results.map((r) => r.sourceStatedValue).sort();
    expect(stated).toEqual([40, 60]);
  });
});

describe("runVerify — reconciliation identity", () => {
  it("the five outcome counters always sum to sourceChecksAttempted and to results.length", async () => {
    const facilities = [
      makeFacility({ id: "f-confirmed", capacityMw: { operational: 100 } }),
      makeFacility({ id: "f-disagreement", capacityMw: { operational: 100 } }),
      makeFacility({ id: "f-no-mention", capacityMw: { operational: 100 } }),
      makeFacility({ id: "f-unreachable", capacityMw: { operational: 100 } }),
    ];

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        if (url.includes("f-unreachable")) return { ok: false, reason: "http_error", httpStatus: 500 };
        if (url.includes("f-no-mention")) {
          return {
            ok: true,
            text: `No power figures on this page at all. ${"Filler text about permitting. ".repeat(20)}`,
            finalUrl: url,
            httpStatus: 200,
          };
        }
        const value = url.includes("f-disagreement") ? 400 : 100;
        return {
          ok: true,
          text: `The facility has an operational capacity of ${value} MW. ${"Filler sentence about the site. ".repeat(20)}`,
          finalUrl: url,
          httpStatus: 200,
        };
      },
      callOllamaImpl: async (opts) => {
        const match = opts.userPrompt.match(/operational capacity of (\d+) MW/);
        const value = match ? Number(match[1]) : null;
        return { ok: true, data: { value, verbatimQuote: match ? match[0] : null, reasonIfNull: value === null ? "not stated" : null } };
      },
      now: fixedNow,
    };

    const withSources = facilities.map((f) => ({
      ...f,
      sources: [{ url: `https://example.com/${f.id}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" as const }],
    }));

    const summary = await runVerify(withSources, { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    const sum = summary.confirmed + summary.disagreements + summary.unconfirmed + summary.noMention + summary.unreachable;
    expect(sum).toBe(summary.sourceChecksAttempted);
    expect(sum).toBe(summary.results.length);
    expect(summary.sourceChecksAttempted).toBe(4);
  });
});

describe("runVerify — abort guard on a consecutive total-fetch-failure streak", () => {
  it("returns an ABORTED summary (never throws) once the streak reaches CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD", async () => {
    const facilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD }, (_, i) =>
      makeFacility({
        id: `bad-facility-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "network_error" }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify(facilities, { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.aborted).toBe(true);
    expect(typeof summary.abortReason).toBe("string");
    expect(summary.unreachable).toBe(CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD);
  });

  it("preserves results found before the abort — an aborted run must not discard legitimate findings", async () => {
    const goodFacility = makeFacility({
      id: "good-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/good", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
    });
    const badFacilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD }, (_, i) =>
      makeFacility({
        id: `bad-facility-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        if (url.includes("good")) {
          return {
            ok: true,
            text: `The facility has an operational capacity of 250 MW. ${"Filler sentence about the site. ".repeat(20)}`,
            finalUrl: url,
            httpStatus: 200,
          };
        }
        return { ok: false, reason: "network_error" };
      },
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 250, verbatimQuote: "operational capacity of 250 MW", reasonIfNull: null },
      }),
      now: fixedNow,
    };

    const summary = await runVerify([goodFacility, ...badFacilities], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.aborted).toBe(true);
    expect(summary.disagreements).toBe(1);
    expect(summary.results.some((r) => r.facilityId === "good-facility" && r.outcome === "disagreement")).toBe(true);
  });

  it("does not trip below the threshold", async () => {
    const facilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeFacility({
        id: `bad-facility-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "network_error" }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify(facilities, { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.aborted).toBe(false);
    expect(summary.unreachable).toBe(CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1);
  });
});

describe("runVerify — --limit caps VALUES checked, not source-checks", () => {
  it("limits the number of (facility, field) values selected, matching extract-fields.ts's gap-style semantics", async () => {
    const facilities = [
      makeFacility({
        id: "f1",
        capacityMw: { operational: 100 },
        sources: [{ url: "https://example.com/f1", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      }),
      makeFacility({
        id: "f2",
        capacityMw: { operational: 100 },
        sources: [{ url: "https://example.com/f2", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      }),
    ];

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({
        ok: true,
        text: `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`,
        finalUrl: url,
        httpStatus: 200,
      }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
    };

    const summary = await runVerify(facilities, { fields: ["capacityMw.operational"], limit: 1, runId: "test-run" }, deps);

    expect(summary.valuesConsidered).toBe(1);
    expect(summary.facilitiesConsidered).toBe(1);
  });
});

// ============================================================================
// Per-VALUE accounting — the coverage hole the triple-level tally cannot
// see: a value whose facility contributes ZERO attempted triples is
// invisible to the five outcome counters and, without this layer,
// indistinguishable from a fully-checked value.
// ============================================================================

describe("runVerify — per-value accounting: valuesUnchecked (the coverage hole)", () => {
  it("a facility whose only source is a PDF lands its value in uncheckedValues with reason allSourcesPdf, contributes zero triples", async () => {
    const facility = makeFacility({
      id: "pdf-only-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/report.pdf", label: "PDF report", retrievedAt: "2026-01-01", kind: "filing" }],
    });

    let fetchCalls = 0;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        fetchCalls++;
        return { ok: true, text: "should never be reached", finalUrl: url, httpStatus: 200 };
      },
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(fetchCalls).toBe(0); // the PDF is never even fetched
    expect(summary.sourceChecksAttempted).toBe(0);
    expect(summary.valuesChecked).toBe(0);
    expect(summary.valuesUnchecked).toBe(1);
    expect(summary.uncheckedValues).toEqual([
      {
        facilityId: "pdf-only-facility",
        facilityName: "Test Facility",
        field: "capacityMw.operational",
        recordedValue: 100,
        reason: "allSourcesPdf",
      },
    ]);
  });

  it("a facility with no sources at all lands its value in uncheckedValues with reason noSources", async () => {
    const facility = makeFacility({ id: "no-sources-facility", capacityMw: { operational: 100 }, sources: [] });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: "unreachable in this test", finalUrl: url, httpStatus: 200 }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.valuesUnchecked).toBe(1);
    expect(summary.uncheckedValues[0]?.reason).toBe("noSources");
  });

  it("does not perturb the consecutive-fetch-failure abort streak — an all-PDF facility is a data characteristic, not evidence of network collapse", async () => {
    // THRESHOLD - 1 genuine fetch failures interleaved with an all-PDF
    // facility must NOT trip the abort — if the all-PDF facility were
    // (wrongly) counted as a fetch failure, this would reach the threshold
    // and abort.
    const genuineFailures = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeFacility({
        id: `bad-facility-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );
    const pdfOnlyFacility = makeFacility({
      id: "pdf-only-interspersed",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/report.pdf", label: "PDF report", retrievedAt: "2026-01-01", kind: "filing" }],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "network_error" }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [...genuineFailures, pdfOnlyFacility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.aborted).toBe(false);
    expect(summary.unreachable).toBe(CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1);
    expect(summary.valuesUnchecked).toBe(1);
    expect(summary.uncheckedValues[0]?.reason).toBe("allSourcesPdf");
  });

  it("a facility never reached because of an abort lands its value in uncheckedValues with reason abortedBeforeReached", async () => {
    const badFacilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD }, (_, i) =>
      makeFacility({
        id: `bad-facility-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );
    const neverReachedFacility = makeFacility({
      id: "never-reached-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/never-reached", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "network_error" }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [...badFacilities, neverReachedFacility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.aborted).toBe(true);
    const neverReached = summary.uncheckedValues.find((u) => u.facilityId === "never-reached-facility");
    expect(neverReached?.reason).toBe("abortedBeforeReached");
  });

  it("the per-value identity valuesChecked + valuesUnchecked === valuesConsidered holds on a mixed run, and the summary reports BOTH a confirmed value and an unchecked one", async () => {
    const confirmedFacility = makeFacility({
      id: "confirmed-in-mix",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/confirmed-in-mix", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
    });
    const pdfOnlyFacility = makeFacility({
      id: "unchecked-in-mix",
      capacityMw: { operational: 200 },
      sources: [{ url: "https://example.com/report.pdf", label: "PDF report", retrievedAt: "2026-01-01", kind: "filing" }],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({
        ok: true,
        text: `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`,
        finalUrl: url,
        httpStatus: 200,
      }),
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [confirmedFacility, pdfOnlyFacility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    // This is the case that would currently mislead a reader without the
    // per-value layer: 1 confirmed, 1 that was never even attempted, and
    // the totals must clearly show both, not just the confirmation.
    expect(summary.valuesConsidered).toBe(2);
    expect(summary.valuesChecked).toBe(1);
    expect(summary.valuesUnchecked).toBe(1);
    expect(summary.valuesChecked + summary.valuesUnchecked).toBe(summary.valuesConsidered);
    expect(summary.confirmed).toBe(1);
    expect(summary.uncheckedValues[0]?.facilityId).toBe("unchecked-in-mix");
  });
});
