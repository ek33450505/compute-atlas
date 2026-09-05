import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  buildFacilityNameIndex,
  buildSourceUrlIndex,
  findMirrorImage,
  formatSummary,
  loadFacilitiesFile,
  loadReport,
  normalizeSourceUrl,
  parseArgs,
  triageDisagreements,
  type TriageDisagreementsResult,
} from "./triage-disagreements";
import type { SourceVerification, VerifyFieldsSummary } from "./verify-fields";
import type { Facility } from "../../lib/schema";

// ============================================================================
// Fixtures — mirrors the makeFacility/makeVerification shape used by
// verify-fields.test.ts, kept minimal to this file's own needs.
// ============================================================================

function makeFacility(overrides: Partial<Facility> & { id: string; sources: Facility["sources"] }): Facility {
  return {
    name: overrides.id,
    operator: "Test Operator",
    status: "operational",
    facilityType: "data_center",
    confidence: "confirmed",
    location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
    statusHistory: [],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

function makeResult(overrides: Partial<SourceVerification> & { facilityId: string }): SourceVerification {
  return {
    facilityId: overrides.facilityId,
    facilityName: overrides.facilityName ?? overrides.facilityId,
    field: overrides.field ?? "capacityMw.operational",
    recordedValue: overrides.recordedValue ?? 100,
    sourceUrl: overrides.sourceUrl ?? "https://example.com/a",
    outcome: overrides.outcome ?? "disagreement",
    sourceStatedValue: overrides.sourceStatedValue,
    verbatimQuote: overrides.verbatimQuote,
  };
}

function makeSummary(results: SourceVerification[]): VerifyFieldsSummary {
  return {
    runId: "test-run",
    generatedAt: "2026-09-05T00:00:00.000Z",
    facilitiesConsidered: results.length,
    valuesConsidered: results.length,
    valuesChecked: results.length,
    valuesUnchecked: 0,
    uncheckedValues: [],
    sourceChecksAttempted: results.length,
    sourcesSkippedNonDocument: 0,
    confirmed: 0,
    disagreements: results.filter((r) => r.outcome === "disagreement").length,
    unconfirmed: 0,
    noMention: 0,
    unreachable: 0,
    recoveredViaArchive: 0,
    aborted: false,
    abortReason: null,
    results,
  };
}

// ============================================================================
// URL normalization
// ============================================================================

describe("normalizeSourceUrl", () => {
  it("matches a bare path, a trailing slash, and a fragment, but nothing else", () => {
    const bare = normalizeSourceUrl("https://Example.com/x");
    expect(normalizeSourceUrl("https://example.com/x/")).toBe(bare);
    expect(normalizeSourceUrl("https://EXAMPLE.com/x#section-2")).toBe(bare);
    expect(normalizeSourceUrl("HTTPS://example.com/x")).toBe(bare);
  });

  it("does NOT treat two URLs differing only by query string as the same source", () => {
    expect(normalizeSourceUrl("https://example.com/permit?id=1")).not.toBe(
      normalizeSourceUrl("https://example.com/permit?id=2"),
    );
  });

  it("falls back to a best-effort normalization for an unparseable URL rather than throwing", () => {
    expect(() => normalizeSourceUrl("not a url")).not.toThrow();
  });
});

// ============================================================================
// Source-URL index (and the machine-data exclusion)
// ============================================================================

describe("buildSourceUrlIndex", () => {
  it("excludes ArcGIS/OSM/GIS-endpoint URLs from a facility's source set", () => {
    const facilities = [
      makeFacility({
        id: "f1",
        sources: [
          { url: "https://www.arcgis.com/home/item.html?id=abc", label: "map", publisher: "Esri", retrievedAt: "2026-01-01", kind: "other" },
          { url: "https://example.com/press-release", label: "press", publisher: "Example", retrievedAt: "2026-01-01", kind: "press" },
        ],
      }),
    ];
    const index = buildSourceUrlIndex(facilities);
    expect([...index.get("f1")!]).toEqual([normalizeSourceUrl("https://example.com/press-release")]);
  });

  it("builds a live facility-id -> name index", () => {
    const facilities = [
      makeFacility({ id: "f1", name: "Facility One", sources: [{ url: "https://example.com/a", label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
    ];
    expect(buildFacilityNameIndex(facilities).get("f1")).toBe("Facility One");
  });
});

// ============================================================================
// triageDisagreements — the core partition
// ============================================================================

describe("triageDisagreements", () => {
  it("puts a disagreement whose facility shares no source with anything into uniqueSource", () => {
    const facilities = [
      makeFacility({ id: "lonely", sources: [{ url: "https://example.com/lonely", label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
      makeFacility({ id: "other", sources: [{ url: "https://example.com/other", label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
    ];
    const summary = makeSummary([
      makeResult({ facilityId: "lonely", sourceUrl: "https://example.com/lonely", recordedValue: 100, sourceStatedValue: 200 }),
    ]);

    const result = triageDisagreements(summary, facilities);

    expect(result.uniqueSource).toHaveLength(1);
    expect(result.uniqueSource[0].facilityId).toBe("lonely");
    expect(result.uniqueSource[0].siblings).toEqual([]);
    expect(result.sharedSourceSiblings).toHaveLength(0);
  });

  it("PINS AN INTENTIONAL TRADE-OFF: two facilities whose ONLY shared source is machine-data are not detected as siblings, so a shared-source artifact is falsely promoted to uniqueSource", () => {
    // This is the accepted, deliberate cost of excluding machine-data URLs (ArcGIS/OSM/
    // GIS endpoints) from the sibling-detection intersection — see the file header's
    // "MACHINE-DATA URLS ARE EXCLUDED" section. If these two facilities' only common
    // citation were a normal document, they'd be flagged as shared-source siblings; because
    // it's an ArcGIS map item, `buildSourceUrlIndex` drops it from both sets before the
    // intersection ever runs, so no sibling is found and the disagreement is falsely
    // PROMOTED to `uniqueSource` — the more expensive failure direction, since a human is
    // now escalated a "real" candidate that is actually a shared-source artifact.
    // DO NOT "fix" this by asserting the opposite: this outcome is the accepted cost of the
    // exclusion, not a defect. If `census-triage.ts`'s `matchMachineDataRule` rule set ever
    // narrows (e.g. stops matching arcgis.com), THIS test is the tripwire that should flip
    // to failing, surfacing the change here rather than silently.
    const arcgisUrl = "https://www.arcgis.com/home/item.html?id=abc123";
    const facilities = [
      makeFacility({
        id: "shares-only-arcgis",
        sources: [{ url: arcgisUrl, label: "map", publisher: "Esri", retrievedAt: "2026-01-01", kind: "other" }],
      }),
      makeFacility({
        id: "other-arcgis-citer",
        sources: [{ url: arcgisUrl, label: "map", publisher: "Esri", retrievedAt: "2026-01-01", kind: "other" }],
      }),
    ];
    const summary = makeSummary([
      makeResult({ facilityId: "shares-only-arcgis", sourceUrl: arcgisUrl, recordedValue: 100, sourceStatedValue: 150 }),
    ]);

    const result = triageDisagreements(summary, facilities);

    expect(result.uniqueSource).toHaveLength(1);
    expect(result.uniqueSource[0].facilityId).toBe("shares-only-arcgis");
    expect(result.uniqueSource[0].siblings).toEqual([]);
    expect(result.sharedSourceSiblings).toHaveLength(0);
  });

  it("puts a shared-source, non-mirror pair into sharedSourceSiblings with the shared URL named", () => {
    const sharedUrl = "https://example.com/shared-press-release";
    const facilities = [
      makeFacility({
        id: "east",
        sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }],
      }),
      makeFacility({
        id: "west",
        sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }],
      }),
    ];
    // Both cite the same document and both disagree with it, but NOT as a
    // reciprocal swap — east=2/source=5, west=3/source=5 — so this is a real
    // shared-source sibling case, not a mirror image (see the file's own
    // AgriFORCE East Palestine / West Point example, measured on the live
    // 2026-09-05 nightly report).
    const summary = makeSummary([
      makeResult({ facilityId: "east", sourceUrl: sharedUrl, recordedValue: 2, sourceStatedValue: 5 }),
      makeResult({ facilityId: "west", sourceUrl: sharedUrl, recordedValue: 3, sourceStatedValue: 5 }),
    ]);

    const result = triageDisagreements(summary, facilities);

    expect(result.uniqueSource).toHaveLength(0);
    expect(result.sharedSourceSiblings).toHaveLength(2);
    const east = result.sharedSourceSiblings.find((d) => d.facilityId === "east")!;
    expect(east.siblings).toEqual([{ facilityId: "west", facilityName: "west", sharedSourceUrls: [normalizeSourceUrl(sharedUrl)] }]);
    expect(east.mirrorImage).toBeUndefined();
  });

  it("flags a true mirror-image pair — values are an exact swap across a shared source", () => {
    const sharedUrl = "https://example.com/marshall-energy-center";
    const facilities = [
      makeFacility({ id: "alterra-compute", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
      makeFacility({ id: "alterra-gas", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
    ];
    const summary = makeSummary([
      makeResult({ facilityId: "alterra-compute", sourceUrl: sharedUrl, recordedValue: 1400, sourceStatedValue: 1000 }),
      makeResult({ facilityId: "alterra-gas", sourceUrl: sharedUrl, recordedValue: 1000, sourceStatedValue: 1400 }),
    ]);

    const result = triageDisagreements(summary, facilities);

    expect(result.mirrorImageCount).toBe(2);
    const compute = result.sharedSourceSiblings.find((d) => d.facilityId === "alterra-compute")!;
    expect(compute.mirrorImage).toEqual({
      facilityId: "alterra-gas",
      facilityName: "alterra-gas",
      recordedValue: 1000,
      sourceStatedValue: 1400,
    });
    const gas = result.sharedSourceSiblings.find((d) => d.facilityId === "alterra-gas")!;
    expect(gas.mirrorImage?.facilityId).toBe("alterra-compute");
  });

  it("does not flag a mirror image across different fields, even with swapped-looking numbers", () => {
    const sharedUrl = "https://example.com/shared";
    const facilities = [
      makeFacility({ id: "a", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
      makeFacility({ id: "b", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
    ];
    const summary = makeSummary([
      makeResult({ facilityId: "a", field: "capacityMw.operational", sourceUrl: sharedUrl, recordedValue: 100, sourceStatedValue: 50 }),
      makeResult({ facilityId: "b", field: "energy.onSiteGenerationMw", sourceUrl: sharedUrl, recordedValue: 50, sourceStatedValue: 100 }),
    ]);

    const result = triageDisagreements(summary, facilities);

    expect(result.mirrorImageCount).toBe(0);
    expect(result.sharedSourceSiblings.every((d) => d.mirrorImage === undefined)).toBe(true);
  });

  it("pins the RECONCILE_TOLERANCE boundary directly: a pair just inside 5% is a mirror image, a pair just outside is not", () => {
    // The mirror-image tests above (1400 vs 1000, a 29% difference) sit far outside
    // RECONCILE_TOLERANCE and would still pass if the locally-duplicated constant (see the
    // file's own COUPLING comment above its definition) drifted substantially. This test
    // isolates the comparison AT the boundary: facility "boundary-a" recorded=1000,
    // source-stated=2000; its sibling "boundary-b"'s recorded value is fixed at exactly
    // 2000, so it always matches boundary-a's source-stated value — the ONLY thing that
    // varies between the two scenarios below is whether boundary-b's source-stated value
    // (951 vs 949) falls inside or outside 5% of boundary-a's recorded value (1000): a
    // ratio of 0.049 (< 0.05, just inside) vs 0.051 (> 0.05, just outside).
    const sharedUrl = "https://example.com/boundary-shared-source";
    const facilities = [
      makeFacility({ id: "boundary-a", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
      makeFacility({ id: "boundary-b", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
    ];

    const insideSummary = makeSummary([
      makeResult({ facilityId: "boundary-a", sourceUrl: sharedUrl, recordedValue: 1000, sourceStatedValue: 2000 }),
      makeResult({ facilityId: "boundary-b", sourceUrl: sharedUrl, recordedValue: 2000, sourceStatedValue: 951 }), // |1000-951|/1000 = 0.049
    ]);
    const insideResult = triageDisagreements(insideSummary, facilities);
    const insideA = insideResult.sharedSourceSiblings.find((d) => d.facilityId === "boundary-a");
    expect(insideA?.mirrorImage).toEqual({
      facilityId: "boundary-b",
      facilityName: "boundary-b",
      recordedValue: 2000,
      sourceStatedValue: 951,
    });

    const outsideSummary = makeSummary([
      makeResult({ facilityId: "boundary-a", sourceUrl: sharedUrl, recordedValue: 1000, sourceStatedValue: 2000 }),
      makeResult({ facilityId: "boundary-b", sourceUrl: sharedUrl, recordedValue: 2000, sourceStatedValue: 949 }), // |1000-949|/1000 = 0.051
    ]);
    const outsideResult = triageDisagreements(outsideSummary, facilities);
    const outsideA = outsideResult.sharedSourceSiblings.find((d) => d.facilityId === "boundary-a");
    expect(outsideA?.mirrorImage).toBeUndefined();
  });

  it("produces an empty, non-crashing result for a report with zero disagreements", () => {
    const summary = makeSummary([makeResult({ facilityId: "f1", outcome: "confirmed", sourceStatedValue: 100 })]);
    const result = triageDisagreements(summary, []);

    expect(result.totalDisagreements).toBe(0);
    expect(result.uniqueSource).toEqual([]);
    expect(result.sharedSourceSiblings).toEqual([]);
    expect(result.mirrorImageCount).toBe(0);
    expect(() => formatSummary(result)).not.toThrow();
  });

  it("warns and falls back to the report's own sourceUrl when the facility is missing from the dataset", () => {
    const summary = makeSummary([
      makeResult({ facilityId: "ghost", sourceUrl: "https://example.com/ghost", recordedValue: 1, sourceStatedValue: 2 }),
    ]);
    const result = triageDisagreements(summary, []);

    expect(result.uniqueSource).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("ghost");
  });
});

// ============================================================================
// findMirrorImage — unit-level, independent of the full partition
// ============================================================================

describe("findMirrorImage", () => {
  it("returns undefined when recorded/source-stated values are not both numeric", () => {
    const entry = makeResult({ facilityId: "a", field: "energy.source", recordedValue: "Xcel", sourceStatedValue: "NV Energy" });
    expect(findMirrorImage(entry, new Set(["b"]), [entry])).toBeUndefined();
  });
});

// ============================================================================
// loadReport / loadFacilitiesFile — clear errors, never a raw stack trace
// ============================================================================

describe("loadReport", () => {
  it("throws a clear, path-naming error for a missing file rather than an uncaught exception shape", () => {
    expect(() => loadReport("/nonexistent/path/report.json")).toThrow(/could not read verify-fields report/);
  });

  it("throws a clear error for a report missing its results array", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "triage-disagreements-test-"));
    try {
      const tmp = path.join(dir, "report.json");
      writeFileSync(tmp, JSON.stringify({ runId: "x" }));
      expect(() => loadReport(tmp)).toThrow(/does not look like a verify-fields report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadFacilitiesFile", () => {
  it("throws a clear error for a missing file", () => {
    expect(() => loadFacilitiesFile("/nonexistent/path/facilities.json")).toThrow(/could not read facilities file/);
  });

  it("throws a clear error when the file is not a JSON array", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "triage-disagreements-test-"));
    try {
      const tmp = path.join(dir, "facilities.json");
      writeFileSync(tmp, JSON.stringify({ not: "an array" }));
      expect(() => loadFacilitiesFile(tmp)).toThrow(/is not a JSON array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// parseArgs
// ============================================================================

describe("parseArgs", () => {
  it("requires --report", () => {
    expect(() => parseArgs([])).toThrow(/--report=<path> is required/);
  });

  it("parses --report, --facilities, and --out", () => {
    expect(parseArgs(["--report=a.json", "--facilities=b.json", "--out=c.json"])).toEqual({
      reportPath: "a.json",
      facilitiesPath: "b.json",
      outPath: "c.json",
    });
  });

  it("defaults --facilities to data/facilities.json and leaves --out unset", () => {
    expect(parseArgs(["--report=a.json"])).toEqual({
      reportPath: "a.json",
      facilitiesPath: "data/facilities.json",
      outPath: undefined,
    });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--report=a.json", "--bogus"])).toThrow(/Unknown argument/);
  });
});

// ============================================================================
// No network access, ever — a fetch stub that throws proves this tool never
// calls it, across the full triage + summary path.
// ============================================================================

describe("network isolation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls fetch anywhere in the triage or summary path", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("triage-disagreements.ts must never make a network call");
      }),
    );

    const sharedUrl = "https://example.com/shared";
    const facilities = [
      makeFacility({ id: "a", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
      makeFacility({ id: "b", sources: [{ url: sharedUrl, label: "x", publisher: "x", retrievedAt: "2026-01-01", kind: "press" }] }),
    ];
    const summary = makeSummary([
      makeResult({ facilityId: "a", sourceUrl: sharedUrl, recordedValue: 100, sourceStatedValue: 50 }),
    ]);

    const result: TriageDisagreementsResult = triageDisagreements(summary, facilities);
    expect(() => formatSummary(result)).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
