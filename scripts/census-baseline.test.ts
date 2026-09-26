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

import { main, parseCliArgs } from "./census-baseline";
import { BASELINE_PATH, HISTORY_PATH } from "./census-history";
import { OUTPUT_PATH, type IndexCensusReport } from "./index-census";

const SAMPLE_REPORT: IndexCensusReport = {
  takenAt: "2026-09-20T10:00:00.000Z",
  siteUrl: "sc-domain:compute-atlas.com",
  sitemapIndexUrl: "https://www.compute-atlas.com/sitemap.xml",
  sitemapSource: "https://www.compute-atlas.com/sitemap.xml",
  sampled: { strategy: "test", totalCandidates: 2, totalInspected: 2 },
  byRoute: {
    "https://x/1": { family: "facilities", coverageState: "Submitted and indexed" },
    "https://x/2": { family: "facilities", coverageState: "Discovered - currently not indexed" },
  },
  summary: {
    byFamily: {
      facilities: {
        inspected: 2,
        indexed: 1,
        discovered_not_indexed: 1,
        crawled_not_indexed: 0,
        excluded: 0,
        other: 0,
      },
    },
  },
};
const SAMPLE_JSON = JSON.stringify(SAMPLE_REPORT);

function mockConsoleLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}
function mockConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
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
  it("defaults replace to false", () => {
    expect(parseCliArgs([])).toEqual({ replace: false });
  });

  it("accepts --replace", () => {
    expect(parseCliArgs(["--replace"])).toEqual({ replace: true });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

// ---------------------------------------------------------------------------
// main — refusals
// ---------------------------------------------------------------------------
describe("main — refusals", () => {
  it("refuses loudly when no census file exists, and never writes a baseline", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(main([])).rejects.toThrow(/No census found/);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("refuses to silently overwrite an existing baseline without --replace", async () => {
    mockExistsSync.mockReturnValue(true); // census present, baseline present
    await expect(main([])).rejects.toThrow(/--replace/);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("overwrites an existing baseline when --replace is given", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_JSON);
    mockConsoleLog();
    await main(["--replace"]);
    expect(mockWriteFileSync).toHaveBeenCalledWith(BASELINE_PATH, SAMPLE_JSON);
  });
});

// ---------------------------------------------------------------------------
// main — freezing
// ---------------------------------------------------------------------------
describe("main — freezing", () => {
  it("freezes the census content byte-for-byte and prints takenAt, sitemapSource, and per-family totals", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === OUTPUT_PATH); // no existing baseline
    mockReadFileSync.mockReturnValue(SAMPLE_JSON);
    const logSpy = mockConsoleLog();

    await main([]);

    expect(mockWriteFileSync).toHaveBeenCalledWith(BASELINE_PATH, SAMPLE_JSON);
    const printed = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain(SAMPLE_REPORT.takenAt);
    expect(printed).toContain(SAMPLE_REPORT.sitemapSource);
    expect(printed).toContain("facilities");
  });
});

// ---------------------------------------------------------------------------
// history append — preserves prior lines, survives a corrupt line
// ---------------------------------------------------------------------------
describe("history append", () => {
  const priorLine1 = JSON.stringify({ takenAt: "2026-09-10T00:00:00.000Z", sitemapSource: "s", byFamily: {} });
  const corruptLine = "{not valid json,,,";
  const priorLine2 = JSON.stringify({ takenAt: "2026-09-15T00:00:00.000Z", sitemapSource: "s", byFamily: {} });

  it("appends after existing history, skips a corrupt line with a warning, and never rewrites/truncates prior lines", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === OUTPUT_PATH || p === HISTORY_PATH);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === OUTPUT_PATH) return SAMPLE_JSON;
      if (p === HISTORY_PATH) return [priorLine1, corruptLine, priorLine2, ""].join("\n");
      throw new Error(`unexpected readFileSync(${String(p)})`);
    });
    mockConsoleLog();
    const errSpy = mockConsoleError();

    await main([]);

    // Append-only: history is never a writeFileSync target (which would
    // imply a rewrite/truncation) — only appendFileSync touches it.
    expect(mockWriteFileSync.mock.calls.some(([p]) => p === HISTORY_PATH)).toBe(false);
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);

    const [appendedPath, appendedContent] = mockAppendFileSync.mock.calls[0];
    expect(appendedPath).toBe(HISTORY_PATH);
    const appendedEntry = JSON.parse(String(appendedContent).trim());
    expect(appendedEntry.takenAt).toBe(SAMPLE_REPORT.takenAt);
    expect(appendedEntry.byFamily.facilities).toEqual({
      inspected: 2,
      indexed: 1,
      discovered_not_indexed: 1,
      crawled_not_indexed: 0,
    });

    // The corrupt line was reported, not silently dropped — and not fatal,
    // since main() completed successfully above.
    expect(errSpy.mock.calls.some((call) => String(call[0]).toLowerCase().includes("not valid json"))).toBe(true);
  });

  it("appends cleanly when no history file exists yet", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === OUTPUT_PATH); // no baseline, no history file
    mockReadFileSync.mockReturnValue(SAMPLE_JSON);
    mockConsoleLog();

    await main([]);

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    expect(mockAppendFileSync.mock.calls[0][0]).toBe(HISTORY_PATH);
  });

  it("keeps a truncated (no-trailing-newline) fragment and the new entry on SEPARATE lines, never glued into one", async () => {
    // Simulates a prior write interrupted mid-flush: the file's last (only)
    // line has no trailing "\n" and is itself incomplete JSON — exactly the
    // fragment scripts/census-history.ts's newline guard exists to protect
    // the NEW entry from gluing onto.
    const truncatedFragment = '{"takenAt":"2026-09-24T00:00:00.000Z","sitemapSource":"s"';
    const linesBefore = truncatedFragment.split("\n").filter((line) => line.length > 0);
    expect(linesBefore).toHaveLength(1);

    mockExistsSync.mockImplementation((p: unknown) => p === OUTPUT_PATH || p === HISTORY_PATH);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === OUTPUT_PATH) return SAMPLE_JSON;
      if (p === HISTORY_PATH) return truncatedFragment;
      throw new Error(`unexpected readFileSync(${String(p)})`);
    });
    mockConsoleLog();
    mockConsoleError(); // the fragment is itself invalid JSON — expect (and suppress) its warning

    await main([]);

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [appendedPath, appendedContent] = mockAppendFileSync.mock.calls[0];
    expect(appendedPath).toBe(HISTORY_PATH);

    // Reconstruct what the real file would contain after this append, and
    // verify the fragment and the new entry are two SEPARATE lines.
    const resultingFile = truncatedFragment + String(appendedContent);
    const linesAfter = resultingFile.split("\n").filter((line) => line.length > 0);
    expect(linesAfter).toHaveLength(linesBefore.length + 1);
    expect(linesAfter[0]).toBe(truncatedFragment);

    // The new entry must parse as valid JSON entirely on its own.
    expect(() => JSON.parse(linesAfter[1])).not.toThrow();
    const newEntry = JSON.parse(linesAfter[1]);
    expect(newEntry.takenAt).toBe(SAMPLE_REPORT.takenAt);
  });
});
