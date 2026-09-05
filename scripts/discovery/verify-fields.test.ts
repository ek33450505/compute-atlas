import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  selectValuesToVerify,
  valuesReconcile,
  runVerify,
  parseArgs,
  type VerifyFieldsDeps,
} from "./verify-fields";
import { CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD, atomicWriteJson } from "./extract-fields";
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

/** Default `fetchPdfTextImpl` for tests that never expect it to be called
 * (i.e. every source in the test is non-PDF). Throwing on any call makes an
 * accidental PDF fetch fail loudly instead of silently returning a
 * plausible-looking result that would mask a routing bug. */
async function unexpectedPdfFetch(url: string): Promise<never> {
  throw new Error(`fetchPdfTextImpl unexpectedly called for ${url}`);
}

/** Symmetric counterpart for tests whose only source is a `.pdf` URL — those
 * are routed straight to `fetchPdfTextImpl` by `fetchSourceText` and must
 * never reach `fetchPageTextImpl` at all. */
async function unexpectedPageFetch(url: string): Promise<never> {
  throw new Error(`fetchPageTextImpl unexpectedly called for ${url}`);
}

// ============================================================================
// Wayback-fallback test doubles — every test whose `fetchPageTextImpl` (or
// `fetchPdfTextImpl`) returns `http_error`/`network_error` now triggers a
// recovery attempt (see verify-fields.ts's WAYBACK FALLBACK section), so it
// MUST inject both `fetchImpl` (never the real global `fetch` — this module
// must never open a socket) and `sleep` (never a real wait) or the run would
// silently hit archive.org and take ~1.2s per failed source. Mirrors
// verify-source.test.ts's own `waybackJson`/`waybackUnavailable` doubles.
// ============================================================================

/** Immediate no-op — the real `VerifyFieldsDeps.sleep` paces Wayback
 * availability lookups in production; tests must never actually wait.
 * Deliberately takes no `ms` parameter (a function with fewer parameters is
 * structurally assignable to `(ms: number) => Promise<void>`) so there is no
 * unused-parameter warning to suppress. */
async function noopSleep(): Promise<void> {}

/** `findWaybackSnapshotUrl` reads via `readCappedText` (a `Content-Length`
 * check + `res.text()`), not `res.json()` directly — this mock's shape
 * matches that: no declared Content-Length (falls through the early bail)
 * and a `text()` resolving to the JSON string to be parsed. */
function waybackJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null } as unknown as Headers,
    text: async () => JSON.stringify(body),
  } as Response;
}

/** Default double for tests that don't care about Wayback recovery at all —
 * reports "no snapshot available" for every URL, so a source that already
 * failed to fetch directly stays `unreachable` exactly as it did before this
 * fallback existed. */
function waybackUnavailable() {
  return vi.fn<typeof fetch>(async () => waybackJson({ archived_snapshots: {} }));
}

function waybackAvailable(snapshotUrl: string) {
  return vi.fn<typeof fetch>(async () => waybackJson({ archived_snapshots: { closest: { available: true, url: snapshotUrl } } }));
}

/** Safety-net double: throws if the Wayback availability endpoint is ever
 * queried in a test that isn't exercising recovery — proves a non-recoverable
 * failure reason (e.g. `bad_content_type`) never attempts a lookup at all. */
function waybackNeverCalled() {
  return vi.fn<typeof fetch>(async () => {
    throw new Error("wayback fetchImpl must not be called in this test");
  });
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
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

// ============================================================================
// Issue #230: ArcGIS/OSM/Nominatim citations are real provenance but cannot
// be read as documents — `verifyFacility` must skip them BEFORE ever calling
// `fetchSourceText`, producing NO triple at all (never `unreachable`). See
// non-document-source.ts and this file's UncheckedReason.allSourcesNonDocument
// doc-comment.
// ============================================================================

describe("runVerify — skips non-document sources before fetching (issue #230)", () => {
  it("skips an ArcGIS FeatureServer source without fetching it, and still reads an ordinary article source", async () => {
    const facility = makeFacility({
      id: "mixed-sources-facility",
      capacityMw: { operational: 100 },
      sources: [
        {
          url: "https://gis.example.gov/arcgis/rest/services/Territory/FeatureServer/0/query",
          label: "GIS layer",
          retrievedAt: "2026-01-01",
          kind: "other",
        },
        { url: "https://example.com/article", label: "Press release", retrievedAt: "2026-01-01", kind: "press" },
      ],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        if (url.includes("FeatureServer")) {
          throw new Error("fetchPageTextImpl must not be called for a skipped non-document source");
        }
        return {
          ok: true,
          text: `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`,
          finalUrl: url,
          httpStatus: 200,
        };
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackNeverCalled(),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.sourcesSkippedNonDocument).toBe(1);
    expect(summary.sourceChecksAttempted).toBe(1); // only the article source was attempted
    expect(summary.confirmed).toBe(1);
    expect(summary.valuesUnchecked).toBe(0); // the value WAS checked, via the article source
  });

  it("skips a kind: 'osm' source regardless of its URL shape, without fetching it", async () => {
    const facility = makeFacility({
      id: "osm-kind-facility",
      capacityMw: { operational: 100 },
      sources: [
        { url: "https://www.openstreetmap.org/way/12345", label: "OSM way", retrievedAt: "2026-01-01", kind: "osm" },
      ],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => {
        throw new Error("fetchPageTextImpl must not be called for an osm-kind source");
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => {
        throw new Error("callOllamaImpl must not be called — no source was ever readable");
      },
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackNeverCalled(),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.sourcesSkippedNonDocument).toBe(1);
    expect(summary.sourceChecksAttempted).toBe(0);
  });

  it("still fetches the recorded TDLR permit false-positive URLs normally (not skipped)", async () => {
    const facility = makeFacility({
      id: "tdlr-facility",
      capacityMw: { operational: 100 },
      sources: [
        {
          url: "https://www.tdlr.texas.gov/TABS/Search/Project/TABS2025023484",
          label: "TDLR permit record",
          retrievedAt: "2026-01-01",
          kind: "permit",
        },
      ],
    });

    let fetched = false;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        fetched = true;
        return {
          ok: true,
          text: `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`,
          finalUrl: url,
          httpStatus: 200,
        };
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackNeverCalled(),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(fetched).toBe(true);
    expect(summary.sourcesSkippedNonDocument).toBe(0);
    expect(summary.confirmed).toBe(1);
  });

  it("classifies a facility whose sources are ALL non-document as allSourcesNonDocument, not unreachable or unclassified", async () => {
    const facility = makeFacility({
      id: "all-non-document-facility",
      capacityMw: { operational: 100 },
      sources: [
        {
          url: "https://gis.example.gov/arcgis/rest/services/Territory/FeatureServer/0/query",
          label: "GIS layer",
          retrievedAt: "2026-01-01",
          kind: "other",
        },
        { url: "https://nominatim.openstreetmap.org/search?q=example", label: "Geocode", retrievedAt: "2026-01-01", kind: "other" },
      ],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => {
        throw new Error("fetchPageTextImpl must not be called — every source on this facility is non-document");
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => {
        throw new Error("callOllamaImpl must not be called — no source was ever readable");
      },
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackNeverCalled(),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    // Zero triples attempted for this facility — neither `unreachable` nor
    // any other outcome — but the value is explicitly flagged, never silently
    // dropped and never misreported via the `unclassified` accounting-bug path.
    expect(summary.sourceChecksAttempted).toBe(0);
    expect(summary.sourcesSkippedNonDocument).toBe(2);
    expect(summary.valuesChecked).toBe(0);
    expect(summary.valuesUnchecked).toBe(1);
    expect(summary.uncheckedValues).toEqual([
      expect.objectContaining({ facilityId: "all-non-document-facility", reason: "allSourcesNonDocument" }),
    ]);

    // The reconciliation identity must still hold exactly.
    const sum = summary.confirmed + summary.disagreements + summary.unconfirmed + summary.noMention + summary.unreachable;
    expect(sum).toBe(summary.sourceChecksAttempted);
    expect(sum).toBe(summary.results.length);
    expect(summary.valuesChecked + summary.valuesUnchecked).toBe(summary.valuesConsidered);
  });

  it("does not perturb the consecutive-fetch-failure abort streak — an all-non-document facility is not evidence of a network collapse", async () => {
    // One facility per streak "slot," each with ONLY non-document sources —
    // if skips were mistakenly treated as fetch failures, this would trip
    // CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD. It must not.
    const facilities = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD + 5 }, (_, i) =>
      makeFacility({
        id: `all-non-document-${i}`,
        capacityMw: { operational: 100 },
        sources: [
          {
            url: `https://gis.example.gov/arcgis/rest/services/Territory${i}/FeatureServer/0/query`,
            label: "GIS layer",
            retrievedAt: "2026-01-01",
            kind: "other",
          },
        ],
      })
    );

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => {
        throw new Error("fetchPageTextImpl must not be called — every source is non-document");
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => {
        throw new Error("callOllamaImpl must not be called");
      },
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackNeverCalled(),
    };

    const summary = await runVerify(facilities, { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.aborted).toBe(false);
    expect(summary.abortReason).toBeNull();
    expect(summary.valuesUnchecked).toBe(facilities.length);
    expect(summary.uncheckedValues.every((u) => u.reason === "allSourcesNonDocument")).toBe(true);
  });
});

// ============================================================================
// Wayback fallback — recovering a source whose DIRECT fetch failed with
// http_error/network_error. See verify-fields.ts's WAYBACK FALLBACK section.
// ============================================================================

describe("runVerify — Wayback fallback (archived-snapshot recovery)", () => {
  it("recovers a source via a Wayback snapshot with rich text: confirmed, viaArchive true, archiveUrl set, sourceUrl unchanged", async () => {
    const facility = makeFacility({
      id: "archive-confirmed-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/botwalled", label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
    });
    const snapshotUrl = "https://web.archive.org/web/20250101000000/https://example.com/botwalled";
    const archivedText = `The facility has an operational capacity of 102 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    let modelCalls = 0;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        if (url === snapshotUrl) return { ok: true, text: archivedText, finalUrl: url, httpStatus: 200 };
        return { ok: false, reason: "http_error", httpStatus: 403 };
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => {
        modelCalls++;
        return { ok: true, data: { value: 102, verbatimQuote: "operational capacity of 102 MW", reasonIfNull: null } };
      },
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackAvailable(snapshotUrl),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(modelCalls).toBe(1);
    expect(summary.confirmed).toBe(1);
    expect(summary.recoveredViaArchive).toBe(1);
    const result = summary.results[0];
    expect(result?.outcome).toBe("confirmed");
    expect(result?.viaArchive).toBe(true);
    expect(result?.archiveUrl).toBe(snapshotUrl);
    // The ORIGINAL cited URL must never be silently rewritten to the snapshot.
    expect(result?.sourceUrl).toBe("https://example.com/botwalled");
  });

  // THE LOAD-BEARING TEST: a chrome-only archived snapshot must never be
  // misread as "the source doesn't say this" (noMention) — that would be a
  // false absent, the single most expensive failure class this tool guards
  // against (see the file header's CENTRAL DESIGN CONSTRAINT).
  it("floors a chrome-only Wayback snapshot (under MIN_READABLE_CHARS) to unreachable, NEVER noMention, and never calls the model", async () => {
    const facility = makeFacility({
      id: "archive-chrome-only-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/botwalled", label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
    });
    const snapshotUrl = "https://web.archive.org/web/20250101000000/https://example.com/botwalled";
    // Deliberately under MIN_READABLE_CHARS (400) — mimics Wayback's own
    // navigation-chrome-only archive of an uncrawled page.
    const chromeOnlySnapshot = "Wayback Machine. This is an archived version of a page. The archive coverage for this page is incomplete.";

    let modelCalls = 0;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        if (url === snapshotUrl) return { ok: true, text: chromeOnlySnapshot, finalUrl: url, httpStatus: 200 };
        return { ok: false, reason: "http_error", httpStatus: 403 };
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => {
        modelCalls++;
        return { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: null } };
      },
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackAvailable(snapshotUrl),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(modelCalls).toBe(0);
    expect(summary.noMention).toBe(0);
    expect(summary.unreachable).toBe(1);
    expect(summary.recoveredViaArchive).toBe(1);
    const result = summary.results[0];
    expect(result?.outcome).toBe("unreachable");
    expect(result?.viaArchive).toBe(true);
    expect(result?.archiveUrl).toBe(snapshotUrl);
  });

  it("leaves a source unreachable, with viaArchive undefined, when no Wayback snapshot is available at all — and never calls the model", async () => {
    const facility = makeFacility({
      id: "archive-no-snapshot-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/dead-link", label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
    });

    let modelCalls = 0;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "http_error", httpStatus: 404 }),
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => {
        modelCalls++;
        return { ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } };
      },
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(modelCalls).toBe(0);
    expect(summary.unreachable).toBe(1);
    expect(summary.recoveredViaArchive).toBe(0);
    const result = summary.results[0];
    expect(result?.outcome).toBe("unreachable");
    expect(result?.viaArchive).toBeUndefined();
    expect(result?.archiveUrl).toBeUndefined();
  });

  it("never attempts a Wayback lookup for a non-recoverable failure reason (bad_content_type)", async () => {
    const facility = makeFacility({
      id: "archive-bad-content-type-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/weird-content-type", label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
    });

    const deps: VerifyFieldsDeps = {
      // `fetchSourceText` (extract-fields.ts) itself retries a
      // `bad_content_type` page result via `fetchPdfTextImpl` exactly once
      // BEFORE this ever reaches verifyFacility's Wayback gate — unrelated to
      // this test's concern, so the retry is just given a failure to fall
      // through with (its ORIGINAL bad_content_type reason survives either way).
      fetchPageTextImpl: async () => ({ ok: false, reason: "bad_content_type", httpStatus: 200 }),
      fetchPdfTextImpl: async () => ({ ok: false, reason: "bad_content_type", httpStatus: 200 }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
      sleep: noopSleep,
      // Throws if ever called — proves the Wayback lookup itself is never attempted.
      fetchImpl: waybackNeverCalled(),
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.unreachable).toBe(1);
    expect(summary.recoveredViaArchive).toBe(0);
    expect(summary.results[0]?.viaArchive).toBeUndefined();
  });

  it("resets the consecutive-failure streak on a recovered source, so a run mixing recoverable and genuine failures does not abort", async () => {
    const snapshotUrl = "https://web.archive.org/web/20250101000000/https://example.com/recovered";
    const archivedText = `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    // One recoverable facility interspersed among (THRESHOLD - 1) genuinely
    // dead ones: without the reset, this would sit one short of the abort
    // threshold and still not trip — the real assertion here is that the
    // recovered facility's `sawAnyReadable` resets the streak so a run with
    // MORE than (THRESHOLD - 1) consecutive network_error facilities around
    // it still does not abort.
    const genuineFailures = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeFacility({
        id: `bad-facility-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );
    const recoveredFacility = makeFacility({
      id: "recovered-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/recovered", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
    });
    const moreGenuineFailures = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeFacility({
        id: `bad-facility-later-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-later-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        if (url === snapshotUrl) return { ok: true, text: archivedText, finalUrl: url, httpStatus: 200 };
        return { ok: false, reason: "network_error" };
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      sleep: noopSleep,
      // `findWaybackSnapshotUrl` calls this with the availability endpoint
      // URL, `...?url=<encodeURIComponent(the-real-url)>` — "recovered"
      // survives encoding unescaped, so this cheaply routes only the
      // recovered facility's lookup to a real snapshot.
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        return url.includes("recovered")
          ? waybackJson({ archived_snapshots: { closest: { available: true, url: snapshotUrl } } })
          : waybackJson({ archived_snapshots: {} });
      }) as typeof fetch,
    };

    const summary = await runVerify(
      [...genuineFailures, recoveredFacility, ...moreGenuineFailures],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    expect(summary.aborted).toBe(false);
    expect(summary.recoveredViaArchive).toBe(1);
    expect(summary.confirmed).toBe(1);
  });

  it("holds the reconciliation identity (confirmed + disagreements + unconfirmed + noMention + unreachable === sourceChecksAttempted) when archive recoveries are mixed in", async () => {
    const snapshotUrl = "https://web.archive.org/web/20250101000000/https://example.com/recovered-mix";
    const archivedText = `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    const recoveredFacility = makeFacility({
      id: "recovered-mix",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/recovered-mix", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
    });
    const directFacility = makeFacility({
      id: "direct-mix",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/direct-mix", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
    });
    // Also recovers via the same snapshot (`fetchImpl` below resolves every
    // lookup to `snapshotUrl`, regardless of which URL is being looked up) —
    // proves the identity holds with MULTIPLE archive recoveries mixed in,
    // not just one.
    const recoveredFacility2 = makeFacility({
      id: "recovered-mix-2",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/recovered-mix-2", label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => {
        if (url === snapshotUrl) return { ok: true, text: archivedText, finalUrl: url, httpStatus: 200 };
        if (url.includes("direct-mix")) {
          return {
            ok: true,
            text: `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`,
            finalUrl: url,
            httpStatus: 200,
          };
        }
        return { ok: false, reason: "network_error" };
      },
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackAvailable(snapshotUrl),
    };

    const summary = await runVerify(
      [recoveredFacility, directFacility, recoveredFacility2],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    const sum = summary.confirmed + summary.disagreements + summary.unconfirmed + summary.noMention + summary.unreachable;
    expect(sum).toBe(summary.sourceChecksAttempted);
    expect(sum).toBe(summary.results.length);
    expect(summary.sourceChecksAttempted).toBe(3);
    expect(summary.recoveredViaArchive).toBe(2);
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async (opts) => {
        const match = opts.userPrompt.match(/operational capacity of (\d+) MW/);
        const value = match ? Number(match[1]) : null;
        return { ok: true, data: { value, verbatimQuote: match ? match[0] : null, reasonIfNull: value === null ? "not stated" : null } };
      },
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
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
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
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
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 250, verbatimQuote: "operational capacity of 250 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
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
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
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
      fetchPdfTextImpl: unexpectedPdfFetch,
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
  // F1: prior to this change, a PDF-only facility was NEVER fetched at all
  // — its value landed in `uncheckedValues` with reason `allSourcesPdf` and
  // contributed zero triples (`fetchPageTextImpl`/`fetchPdfTextImpl` calls
  // == 0). That exemption is removed: PDFs are now routed through the same
  // `fetchSourceText` router `extract-fields.ts` uses, so a PDF-only
  // facility IS fetched and contributes real triples like any other source.
  it("a PDF-only facility with a readable PDF is fetched via fetchPdfTextImpl and yields real triples (F1)", async () => {
    const facility = makeFacility({
      id: "pdf-only-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/report.pdf", label: "PDF report", retrievedAt: "2026-01-01", kind: "filing" }],
    });
    const pdfText = `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    let pdfFetchCalls = 0;
    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: unexpectedPageFetch,
      fetchPdfTextImpl: async (url) => {
        pdfFetchCalls++;
        return { ok: true, text: pdfText, finalUrl: url, httpStatus: 200, contentType: "application/pdf" };
      },
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    // MUTATION-PROVEN (F1 unit 3): re-adding the old `isLikelyPdf` skip in
    // `verifyFacility` makes `pdfFetchCalls` stay 0 and this whole block
    // fail — confirmed by temporarily restoring the skip, see dispatch
    // report.
    expect(pdfFetchCalls).toBe(1);
    expect(summary.sourceChecksAttempted).toBe(1);
    expect(summary.valuesChecked).toBe(1);
    expect(summary.valuesUnchecked).toBe(0);
    expect(summary.confirmed).toBe(1);
    expect(summary.results[0]?.outcome).toBe("confirmed");
  });

  it("a PDF that fails to fetch/extract yields an unreachable triple — never silence, and never treated as the source not stating the field (F1)", async () => {
    const facility = makeFacility({
      id: "pdf-extract-failed-facility",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/report.pdf", label: "PDF report", retrievedAt: "2026-01-01", kind: "filing" }],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: unexpectedPageFetch,
      fetchPdfTextImpl: async () => ({
        ok: false,
        reason: "pdf_extract_failed",
        errorMessage: "pdftotext produced no extractable text",
      }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    // MUTATION-PROVEN (F1 unit 3): swapping this test's expected outcome to
    // "noMention" and re-running confirms it fails — a failed PDF read must
    // never be indistinguishable from "the source doesn't state this" (the
    // file header's CENTRAL DESIGN CONSTRAINT).
    expect(summary.sourceChecksAttempted).toBe(1);
    expect(summary.unreachable).toBe(1);
    expect(summary.results[0]?.outcome).toBe("unreachable");
    expect(summary.noMention).toBe(0);
    expect(summary.confirmed).toBe(0);
    expect(summary.disagreements).toBe(0);
    expect(summary.valuesUnchecked).toBe(0);
  });

  it("a facility with no sources at all lands its value in uncheckedValues with reason noSources", async () => {
    const facility = makeFacility({ id: "no-sources-facility", capacityMw: { operational: 100 }, sources: [] });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: "unreachable in this test", finalUrl: url, httpStatus: 200 }),
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
    };

    const summary = await runVerify([facility], { fields: ["capacityMw.operational"], runId: "test-run" }, deps);

    expect(summary.valuesUnchecked).toBe(1);
    expect(summary.uncheckedValues[0]?.reason).toBe("noSources");
  });

  // F1 DELIBERATELY REMOVES the old exemption: before this change, an
  // all-PDF facility was never fetched at all and was excluded from the
  // consecutive-fetch-failure streak entirely (neither incrementing nor
  // resetting it), because "every cited source is a PDF" was a data
  // characteristic, not evidence of network health. Since PDFs are now
  // actually fetched, a genuine PDF fetch failure IS an ordinary fetch
  // failure and MUST be able to trip this guard — if every PDF in a run is
  // failing (e.g. poppler/pdftotext missing), that is exactly the systemic
  // signal this guard exists to catch, and silently exempting it would
  // reopen the "silence read as success" failure class the guard exists to
  // prevent.
  it("a failed PDF fetch now counts toward the consecutive-fetch-failure abort streak (F1 — the old all-PDF exemption is intentionally removed)", async () => {
    const genuineFailures = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD - 1 }, (_, i) =>
      makeFacility({
        id: `bad-facility-${i}`,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/bad-${i}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );
    const pdfFailureFacility = makeFacility({
      id: "pdf-failure-interspersed",
      capacityMw: { operational: 100 },
      sources: [{ url: "https://example.com/report.pdf", label: "PDF report", retrievedAt: "2026-01-01", kind: "filing" }],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async () => ({ ok: false, reason: "network_error" }),
      fetchPdfTextImpl: async () => ({ ok: false, reason: "pdf_extract_failed", errorMessage: "pdftotext produced no extractable text" }),
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
    };

    const summary = await runVerify(
      [...genuineFailures, pdfFailureFacility],
      { fields: ["capacityMw.operational"], runId: "test-run" },
      deps
    );

    // MUTATION-PROVEN (F1 unit 3): under the OLD semantics this exact shape
    // (THRESHOLD - 1 genuine failures + 1 all-PDF facility) did NOT abort —
    // re-adding the old exemption (excluding an all-PDF facility's failed
    // fetch from the streak) makes `aborted` false again and this assertion
    // fail.
    expect(summary.aborted).toBe(true);
    expect(summary.unreachable).toBe(CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD);
    expect(summary.valuesUnchecked).toBe(0);
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
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({ ok: true, data: { value: 100, verbatimQuote: null, reasonIfNull: null } }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
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
    // Since F1, a PDF-only facility no longer contributes zero triples (its
    // PDF is actually fetched — see the "readable PDF yields real triples"
    // coverage above), so it can no longer stand in for the unchecked case
    // here. A facility with NO sources at all still can — see `noSources`.
    const noSourcesFacility = makeFacility({
      id: "unchecked-in-mix",
      capacityMw: { operational: 200 },
      sources: [],
    });

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({
        ok: true,
        text: `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`,
        finalUrl: url,
        httpStatus: 200,
      }),
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
    };

    const summary = await runVerify(
      [confirmedFacility, noSourcesFacility],
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
    expect(summary.uncheckedValues[0]?.reason).toBe("noSources");
  });
});

describe("parseArgs — --limit fail-open regression guard", () => {
  it("falls back to 500 (not undefined) for a non-numeric --limit=value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const args = parseArgs(["--limit=abc"]);
      expect(args.limit).toBe(500);
      expect(args.limit).not.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to 500 for --limit=0 and --limit=-5", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseArgs(["--limit=0"]).limit).toBe(500);
      expect(parseArgs(["--limit=-5"]).limit).toBe(500);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("leaves limit undefined (unbounded) when --limit is omitted entirely", () => {
    const args = parseArgs(["--fields=capacityMw.operational"]);
    expect(args.limit).toBeUndefined();
  });

  it("accepts a valid --limit=25 unchanged", () => {
    const args = parseArgs(["--limit=25"]);
    expect(args.limit).toBe(25);
  });

  it("applies the same fallback to the space-separated form (--limit abc)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const args = parseArgs(["--limit", "abc"]);
      expect(args.limit).toBe(500);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to 500 (not undefined) for a bare trailing --limit with no value at all", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const args = parseArgs(["--limit"]);
      expect(args.limit).toBe(500);
      expect(args.limit).not.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to 500 for --limit immediately followed by another flag, and does not swallow that flag", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const args = parseArgs(["--limit", "--fields=energy.source"]);
      expect(args.limit).toBe(500);
      expect(args.fields).toEqual(["energy.source"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("still leaves limit undefined (unbounded) when --limit is omitted entirely — the over-correction guard", () => {
    const args = parseArgs([]);
    expect(args.limit).toBeUndefined();
  });
});

// Crash durability — mirrors extract-fields.test.ts's own checkpoint suite.
// `VerifyFieldsDeps.checkpoint` is called once per facility processed so a
// hard crash mid-sweep loses at most one facility's worth of work instead of
// the whole ~17h run. Unlike extract-fields.ts, `VerifyFieldsSummary`'s
// per-outcome counts are tallied INCREMENTALLY inside the facility loop, so
// checkpointing the whole summary object (not just a sub-field) is safe and
// matches the final `--out` write's shape exactly.
describe("runVerify — checkpoint (crash durability)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invokes checkpoint exactly once per facility processed over a multi-facility sweep", async () => {
    const facilities = ["a", "b", "c"].map((id) =>
      makeFacility({
        id,
        capacityMw: { operational: 100 },
        sources: [{ url: `https://example.com/${id}`, label: "Source", retrievedAt: "2026-01-01", kind: "press" }],
      })
    );
    const pageText = `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`;
    const checkpoint = vi.fn();

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      checkpoint,
    };

    const summary = await runVerify(facilities, { fields: ["capacityMw.operational"], runId: "checkpoint-test" }, deps);

    expect(summary.confirmed).toBe(3);
    expect(checkpoint).toHaveBeenCalledTimes(3);
  });

  it("does not write anything when deps.checkpoint is omitted — mirrors main()'s dry-run wiring (no --out)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "verify-fields-checkpoint-test-"));
    const facility = makeFacility({ id: "dry-run-facility", capacityMw: { operational: 100 } });
    const pageText = `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`;

    const deps: VerifyFieldsDeps = {
      fetchPageTextImpl: async (url) => ({ ok: true, text: pageText, finalUrl: url, httpStatus: 200 }),
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      // No `checkpoint` — exactly what main() leaves in place for a dry run
      // (no --out). Nothing in `runVerify` should ever touch the filesystem
      // on its own.
    };

    await runVerify([facility], { fields: ["capacityMw.operational"], runId: "dry-run-test" }, deps);

    expect(readdirSync(dir)).toEqual([]);
  });

  it("preserves results found before an aborted sweep in the checkpointed file — a crash must never lose already-found work", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "verify-fields-checkpoint-test-"));
    const outPath = path.join(dir, "summary.json");

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
      fetchPdfTextImpl: unexpectedPdfFetch,
      callOllamaImpl: async () => ({
        ok: true,
        data: { value: 250, verbatimQuote: "operational capacity of 250 MW", reasonIfNull: null },
      }),
      now: fixedNow,
      sleep: noopSleep,
      fetchImpl: waybackUnavailable(),
      checkpoint: (summary) => atomicWriteJson(outPath, summary),
    };

    const summary = await runVerify(
      [goodFacility, ...badFacilities],
      { fields: ["capacityMw.operational"], runId: "checkpoint-abort-test" },
      deps
    );

    expect(summary.aborted).toBe(true);
    expect(summary.disagreements).toBe(1);

    const onDisk = JSON.parse(readFileSync(outPath, "utf-8")) as typeof summary;
    // Same shape as the final --out write (the whole summary object) — a
    // consumer must not be able to tell a checkpoint file from a final one.
    expect(onDisk.runId).toBe(summary.runId);
    expect(onDisk.disagreements).toBe(1);
    expect(onDisk.results.some((r) => r.facilityId === "good-facility" && r.outcome === "disagreement")).toBe(true);
  });

  it("atomicWriteJson writes valid JSON matching the input, and leaves no .tmp file behind", () => {
    dir = mkdtempSync(path.join(tmpdir(), "verify-fields-checkpoint-test-"));
    const outPath = path.join(dir, "out.json");
    const payload = { runId: "x", results: [] };

    atomicWriteJson(outPath, payload);

    expect(JSON.parse(readFileSync(outPath, "utf-8"))).toEqual(payload);
    expect(readdirSync(dir)).toEqual(["out.json"]);
  });
});
