// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock calls are hoisted above imports, so the shared mock fns go through
// vi.hoisted() (same pattern as scripts/index-census.test.ts).
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockAppendFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
}));

// ⛔ This suite must never touch real files under data/ — every fs call is
// mocked. A live index-coverage census may be running concurrently and
// writes data/index-census.json directly; this file must never read or
// write it for real.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    appendFileSync: mockAppendFileSync,
  };
});

import { computeCensusDiff, main, parseCliArgs, type CensusDiffResult } from "./census-diff";
import { BASELINE_PATH, HISTORY_PATH } from "./census-history";
import { OUTPUT_PATH, type IndexCensusReport, type RouteInspectionEntry } from "./index-census";

function makeReport(takenAt: string, byRoute: Record<string, RouteInspectionEntry>): IndexCensusReport {
  return {
    takenAt,
    siteUrl: "sc-domain:compute-atlas.com",
    sitemapIndexUrl: "https://www.compute-atlas.com/sitemap.xml",
    sitemapSource: "https://www.compute-atlas.com/sitemap.xml",
    sampled: {
      strategy: "test",
      totalCandidates: Object.keys(byRoute).length,
      totalInspected: Object.keys(byRoute).length,
    },
    byRoute,
    summary: { byFamily: {} },
  };
}

function mockConsoleLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------
describe("parseCliArgs", () => {
  it("defaults json to false", () => {
    expect(parseCliArgs([])).toEqual({ json: false });
  });

  it("accepts --json", () => {
    expect(parseCliArgs(["--json"])).toEqual({ json: true });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

// ---------------------------------------------------------------------------
// computeCensusDiff — the core comparison. Pure, no fs.
// ---------------------------------------------------------------------------
describe("computeCensusDiff", () => {
  it("classifies a URL as newly indexed: not indexed in the baseline, indexed now", () => {
    const baseline = makeReport("t1", {
      "https://x/a": { family: "facilities", coverageState: "Discovered - currently not indexed" },
    });
    const current = makeReport("t2", {
      "https://x/a": { family: "facilities", coverageState: "Submitted and indexed" },
    });
    const diff = computeCensusDiff(baseline, current);
    expect(diff.families.facilities.newlyIndexed).toEqual(["https://x/a"]);
    expect(diff.families.facilities.newlyDropped).toEqual([]);
  });

  it("classifies a URL as newly dropped: indexed in the baseline, not indexed now", () => {
    const baseline = makeReport("t1", {
      "https://x/b": { family: "facilities", coverageState: "Submitted and indexed" },
    });
    const current = makeReport("t2", {
      "https://x/b": { family: "facilities", coverageState: "Crawled - currently not indexed" },
    });
    const diff = computeCensusDiff(baseline, current);
    expect(diff.families.facilities.newlyDropped).toEqual(["https://x/b"]);
    expect(diff.families.facilities.newlyIndexed).toEqual([]);
  });

  it("keeps still-discovered_not_indexed and still-crawled_not_indexed in SEPARATE buckets — never merged", () => {
    const baseline = makeReport("t1", {
      "https://x/discovered": { family: "facilities", coverageState: "Discovered - currently not indexed" },
      "https://x/crawled": { family: "facilities", coverageState: "Crawled - currently not indexed" },
    });
    const current = makeReport("t2", {
      "https://x/discovered": { family: "facilities", coverageState: "Discovered - currently not indexed" },
      "https://x/crawled": { family: "facilities", coverageState: "Crawled - currently not indexed" },
    });
    const diff = computeCensusDiff(baseline, current);
    expect(diff.families.facilities.stillDiscoveredNotIndexed).toEqual(["https://x/discovered"]);
    expect(diff.families.facilities.stillCrawledNotIndexed).toEqual(["https://x/crawled"]);
    // The specific misdiagnosis this must never allow: neither bucket may
    // contain the other's URL. This is the assertion the mutation test
    // (merging the two buckets) is expected to break.
    expect(diff.families.facilities.stillDiscoveredNotIndexed).not.toContain("https://x/crawled");
    expect(diff.families.facilities.stillCrawledNotIndexed).not.toContain("https://x/discovered");
  });

  it("surfaces panel drift (URLs present in only one census) rather than silently intersecting", () => {
    const baseline = makeReport("t1", {
      "https://x/only-baseline": { family: "facilities", coverageState: "Submitted and indexed" },
      "https://x/both": { family: "facilities", coverageState: "Submitted and indexed" },
    });
    const current = makeReport("t2", {
      "https://x/both": { family: "facilities", coverageState: "Submitted and indexed" },
      "https://x/only-current": { family: "facilities", coverageState: "Submitted and indexed" },
    });
    const diff = computeCensusDiff(baseline, current);
    expect(diff.panelDrift.onlyInBaseline).toEqual(["https://x/only-baseline"]);
    expect(diff.panelDrift.onlyInCurrent).toEqual(["https://x/only-current"]);
    // The stable overlapping URL must still be classified normally, not
    // swept into drift.
    expect(diff.panelDrift.onlyInBaseline).not.toContain("https://x/both");
    expect(diff.panelDrift.onlyInCurrent).not.toContain("https://x/both");
  });

  it("does not classify movement for a URL missing from either side", () => {
    const baseline = makeReport("t1", {
      "https://x/only-baseline": { family: "facilities", coverageState: "Discovered - currently not indexed" },
    });
    const current = makeReport("t2", {
      "https://x/only-current": { family: "facilities", coverageState: "Submitted and indexed" },
    });
    const diff = computeCensusDiff(baseline, current);
    expect(diff.families).toEqual({});
  });

  it("groups movement per family independently", () => {
    const baseline = makeReport("t1", {
      "https://x/fa": { family: "facilities", coverageState: "Discovered - currently not indexed" },
      "https://x/ca": { family: "counties", coverageState: "Discovered - currently not indexed" },
    });
    const current = makeReport("t2", {
      "https://x/fa": { family: "facilities", coverageState: "Submitted and indexed" },
      "https://x/ca": { family: "counties", coverageState: "Discovered - currently not indexed" },
    });
    const diff = computeCensusDiff(baseline, current);
    expect(diff.families.facilities.newlyIndexed).toEqual(["https://x/fa"]);
    expect(diff.families.counties.stillDiscoveredNotIndexed).toEqual(["https://x/ca"]);
    expect(diff.families.counties.newlyIndexed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// main (CLI) — refusals, --json shape, history append
// ---------------------------------------------------------------------------
describe("main", () => {
  const BASELINE_REPORT = makeReport("2026-09-10T00:00:00.000Z", {
    "https://x/1": { family: "facilities", coverageState: "Discovered - currently not indexed" },
  });
  const CURRENT_REPORT = makeReport("2026-09-24T00:00:00.000Z", {
    "https://x/1": { family: "facilities", coverageState: "Submitted and indexed" },
  });

  function stubBothReportsPresent() {
    mockExistsSync.mockImplementation((p: unknown) => p === OUTPUT_PATH || p === BASELINE_PATH);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === OUTPUT_PATH) return JSON.stringify(CURRENT_REPORT);
      if (p === BASELINE_PATH) return JSON.stringify(BASELINE_REPORT);
      throw new Error(`unexpected readFileSync(${String(p)})`);
    });
  }

  it("refuses loudly when no baseline exists", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === OUTPUT_PATH);
    await expect(main([])).rejects.toThrow(/No baseline found/);
  });

  it("refuses loudly when no census exists", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === BASELINE_PATH);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === BASELINE_PATH) return JSON.stringify(BASELINE_REPORT);
      throw new Error(`unexpected readFileSync(${String(p)})`);
    });
    await expect(main([])).rejects.toThrow(/No census found/);
  });

  it("never writes the census or baseline file", async () => {
    stubBothReportsPresent();
    mockConsoleLog();
    await main([]);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("prints a readable table by default, including the panel-drift warning when the panel moved", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === OUTPUT_PATH || p === BASELINE_PATH);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === OUTPUT_PATH) {
        return JSON.stringify(
          makeReport("t2", {
            "https://x/only-current": { family: "facilities", coverageState: "Submitted and indexed" },
          })
        );
      }
      if (p === BASELINE_PATH) {
        return JSON.stringify(
          makeReport("t1", {
            "https://x/only-baseline": { family: "facilities", coverageState: "Submitted and indexed" },
          })
        );
      }
      throw new Error(`unexpected readFileSync(${String(p)})`);
    });
    const logSpy = mockConsoleLog();
    await main([]);
    const printed = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("Panel drift detected");
    expect(printed).toMatch(/NOT a .*verdict that coverage improved/);
  });

  it("emits machine-readable JSON matching CensusDiffResult's shape with --json", async () => {
    stubBothReportsPresent();
    const logSpy = mockConsoleLog();
    await main(["--json"]);
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0];
    const parsed = JSON.parse(String(lastCall)) as CensusDiffResult;
    expect(parsed.families.facilities.newlyIndexed).toEqual(["https://x/1"]);
    expect(parsed.panelDrift).toEqual({ onlyInBaseline: [], onlyInCurrent: [] });
  });

  it("appends a summary-level history entry for the CURRENT census after diffing", async () => {
    stubBothReportsPresent();
    mockConsoleLog();
    await main([]);
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [path, content] = mockAppendFileSync.mock.calls[0];
    expect(path).toBe(HISTORY_PATH);
    const entry = JSON.parse(String(content).trim());
    expect(entry.takenAt).toBe(CURRENT_REPORT.takenAt);
  });
});
