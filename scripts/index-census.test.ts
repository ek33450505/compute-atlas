// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock calls are hoisted above imports, so the shared mock fns go through
// vi.hoisted() (same pattern as app/page.test.tsx).
const { mockLoadCredentials, mockFetchAccessToken, mockInspectUrl, mockWriteFileSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockLoadCredentials: vi.fn(),
    mockFetchAccessToken: vi.fn(),
    mockInspectUrl: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }));

vi.mock("./check-googlebot-access", () => ({
  loadCredentials: mockLoadCredentials,
  fetchAccessToken: mockFetchAccessToken,
  inspectUrl: mockInspectUrl,
  // index-census.ts now imports SITE_URL from here (see the nit fix removing
  // its own private duplicate) — the mock must supply it too.
  SITE_URL: "sc-domain:compute-atlas.com",
}));

// Only the "--sitemap source lands in the written report" test below drives
// main() far enough (--run, with credentials/token/inspect mocked) to reach
// the real write — mock node:fs so that path, and only that path, can never
// touch this repo's actual data/index-census.json.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: mockWriteFileSync, mkdirSync: mockMkdirSync };
});

import {
  buildCensusPlan,
  buildSummary,
  classifyCoverageState,
  computeFamilyAllocations,
  computeInspectionSpan,
  DEFAULT_TOTAL_TARGET,
  formatDurationWords,
  main,
  MAX_LARGE_FAMILY_SHARE,
  OUTPUT_PATH,
  parseCliArgs,
  reconcileSitemapTotals,
  selectStratifiedSample,
  SITEMAP_INDEX_URL,
  WHOLE_FAMILY_CEILING,
  type RouteInspectionEntry,
} from "./index-census";
import type { SitemapFamilyUrls } from "../lib/sitemap-urls";

// ---------------------------------------------------------------------------
// Network discipline
// ---------------------------------------------------------------------------
// ⛔ NOTHING in this file may reach the Search Console API or the OAuth token
// endpoint — this is the quota `check:googlebot` and a real census would
// spend. Every test either never calls fetch (pure-function blocks, guarded
// below by a throwing default) or stubs it with a controlled fake sitemap
// response; the GSC-facing functions are module-mocked above so an
// accidental real call fails the assertion, not silently reaches Google.
function stubFetch(impl: (input: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sitemapIndexXml(childUrls: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...childUrls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`),
    "</sitemapindex>",
  ].join("\n");
}

function urlsetXml(urls: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `<url><loc>${u}</loc></url>`),
    "</urlset>",
  ].join("\n");
}

function xmlResponse(body: string) {
  return { ok: true, status: 200, statusText: "OK", text: async () => body };
}

function mockConsoleLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

beforeEach(() => {
  stubFetch(() => {
    throw new Error("no network calls allowed in this test file by default");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------
describe("parseCliArgs", () => {
  it("defaults to a dry run with no limit and no family", () => {
    expect(parseCliArgs([])).toEqual({ run: false, limit: undefined, family: undefined });
  });

  it("accepts --run", () => {
    expect(parseCliArgs(["--run"]).run).toBe(true);
  });

  it("parses --limit=N", () => {
    expect(parseCliArgs(["--limit=250"]).limit).toBe(250);
  });

  it("parses --family=<id>", () => {
    expect(parseCliArgs(["--family=facilities"]).family).toBe("facilities");
  });

  // An unparseable limit must not silently become "no limit" — the exact
  // shape of the run.sh ENRICHMENT_LIMIT trap this repo has already hit.
  it.each([
    ["non-numeric", "--limit=abc"],
    ["zero", "--limit=0"],
    ["negative", "--limit=-5"],
    ["fractional", "--limit=2.5"],
    ["empty", "--limit="],
  ])("rejects an unparseable --limit (%s)", (_label, arg) => {
    expect(() => parseCliArgs([arg])).toThrow(/--limit must be a positive integer/);
  });

  it("rejects --family without a value", () => {
    expect(() => parseCliArgs(["--family="])).toThrow(/--family requires a value/);
  });

  it("refuses --full with a clear quota-related message rather than silently blowing the quota", () => {
    expect(() => parseCliArgs(["--full"])).toThrow(/multiple days/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("rejects a bare positional argument", () => {
    expect(() => parseCliArgs(["some-url"])).toThrow(/Unknown argument/);
  });

  it("parses --sitemap=<url> as a validated absolute URL", () => {
    expect(parseCliArgs(["--sitemap=https://staging.example.com/sitemap.xml"]).sitemap).toBe(
      "https://staging.example.com/sitemap.xml"
    );
  });

  it("leaves sitemap undefined when --sitemap is absent (main() resolves the default)", () => {
    expect(parseCliArgs([]).sitemap).toBeUndefined();
  });

  it("accepts an http URL with an explicit port — the actual local-build use case", () => {
    expect(parseCliArgs(["--sitemap=http://localhost:3999/sitemap.xml"]).sitemap).toBe(
      "http://localhost:3999/sitemap.xml"
    );
  });

  it("rejects --sitemap with an empty value", () => {
    expect(() => parseCliArgs(["--sitemap="])).toThrow(/--sitemap requires a value/);
  });

  it("rejects --sitemap that isn't a URL at all, rather than letting it reach a fetch", () => {
    expect(() => parseCliArgs(["--sitemap=notaurl"])).toThrow(
      /--sitemap must be an absolute http\(s\) URL/
    );
  });

  it("rejects a --sitemap with a well-formed but non-http(s) scheme", () => {
    expect(() => parseCliArgs(["--sitemap=file:///etc/passwd"])).toThrow(
      /--sitemap must be an absolute http\(s\) URL/
    );
  });
});

// ---------------------------------------------------------------------------
// selectStratifiedSample — deterministic, no RNG, no clock
// ---------------------------------------------------------------------------
describe("selectStratifiedSample", () => {
  const urls = Array.from({ length: 50 }, (_, i) => `https://example.com/${String(i).padStart(2, "0")}`);

  it("is deterministic across repeated calls on the same input", () => {
    expect(selectStratifiedSample(urls, 10)).toEqual(selectStratifiedSample(urls, 10));
  });

  it("is deterministic across a shuffled input ordering — sorting inside makes order irrelevant", () => {
    const reordered = [...urls].reverse();
    expect(selectStratifiedSample(urls, 10)).toEqual(selectStratifiedSample(reordered, 10));
  });

  it("returns exactly `count` URLs, no duplicates, all drawn from the input", () => {
    const selected = selectStratifiedSample(urls, 12);
    expect(selected).toHaveLength(12);
    expect(new Set(selected).size).toBe(12);
    for (const u of selected) expect(urls).toContain(u);
  });

  it("returns every URL, sorted, when count >= length", () => {
    const small = urls.slice(0, 5);
    expect(selectStratifiedSample(small, 100)).toEqual([...small].sort());
  });

  it("returns an empty array when count is zero or negative", () => {
    expect(selectStratifiedSample(urls, 0)).toEqual([]);
    expect(selectStratifiedSample(urls, -3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeFamilyAllocations — small whole, large capped, none ever zero
// ---------------------------------------------------------------------------
function family(name: string, count: number): SitemapFamilyUrls {
  return {
    family: name,
    sitemapUrl: `https://www.compute-atlas.com/sitemaps/${name}.xml`,
    urls: Array.from({ length: count }, (_, i) => `https://www.compute-atlas.com/${name}/${i}`),
  };
}

describe("computeFamilyAllocations", () => {
  // Under a generous default budget a family just over the ceiling can still
  // legitimately be allocated in full (min(family size, ...) permits it) —
  // so the whole-vs-sampled distinction only becomes externally observable
  // under a tight budget, which is what this asserts: "whole" is
  // unconditional (still 60 even though the budget is only 10), while
  // "large" must share whatever's left and gets compressed accordingly.
  it("treats a family at exactly WHOLE_FAMILY_CEILING as always-whole, and one URL more as sampled down under a tight budget", () => {
    const atCeiling = family("states", WHOLE_FAMILY_CEILING);
    const overCeiling = family("operators", WHOLE_FAMILY_CEILING + 1);
    const allocations = computeFamilyAllocations([atCeiling, overCeiling], 10);

    const statesAlloc = allocations.find((a) => a.family === "states");
    const operatorsAlloc = allocations.find((a) => a.family === "operators");
    expect(statesAlloc?.allocated).toBe(WHOLE_FAMILY_CEILING);
    expect(operatorsAlloc?.allocated).toBeGreaterThan(0);
    expect(operatorsAlloc?.allocated).toBeLessThan(overCeiling.urls.length);
  });

  it("caps a very large family below MAX_LARGE_FAMILY_SHARE and below its own size", () => {
    const [allocation] = computeFamilyAllocations([family("facilities", 2242)], DEFAULT_TOTAL_TARGET);
    expect(allocation.allocated).toBeGreaterThan(0);
    expect(allocation.allocated).toBeLessThanOrEqual(MAX_LARGE_FAMILY_SHARE);
    expect(allocation.allocated).toBeLessThan(allocation.candidates);
  });

  it("never drops a large family to zero even when several compete for the budget", () => {
    const families = [family("operators", 231), family("facilities", 2242), family("counties", 397)];
    const allocations = computeFamilyAllocations(families, DEFAULT_TOTAL_TARGET);
    expect(allocations).toHaveLength(3);
    for (const a of allocations) expect(a.allocated).toBeGreaterThan(0);
  });

  it("represents every family from the real nine-family shape, none at zero, total well under the daily quota", () => {
    const families = [
      family("static", 22),
      family("learn", 7),
      family("states", 55),
      family("operators", 231),
      family("stakeholders", 9),
      family("facilities", 2242),
      family("status", 6),
      family("metros", 28),
      family("counties", 397),
    ];
    const allocations = computeFamilyAllocations(families, DEFAULT_TOTAL_TARGET);
    expect(allocations).toHaveLength(9);
    for (const a of allocations) expect(a.allocated).toBeGreaterThan(0);

    const total = allocations.reduce((sum, a) => sum + a.allocated, 0);
    expect(total).toBeGreaterThan(500);
    expect(total).toBeLessThanOrEqual(DEFAULT_TOTAL_TARGET + 50);
  });

  it("keeps an explicit small totalTarget from being blown past by the large-family floor", () => {
    const [allocation] = computeFamilyAllocations([family("facilities", 2242)], 5);
    expect(allocation.allocated).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// classifyCoverageState — discovered/crawled must stay distinct; unknown is
// "other", never a failure
// ---------------------------------------------------------------------------
describe("classifyCoverageState", () => {
  it.each([
    ["Submitted and indexed", "indexed"],
    ["Indexed, not submitted in sitemap", "indexed"],
    ["Discovered - currently not indexed", "discovered_not_indexed"],
    ["Crawled - currently not indexed", "crawled_not_indexed"],
    ["URL is unknown to Google", "other"],
    ["Blocked by robots.txt", "excluded"],
    ["Excluded by 'noindex' tag", "excluded"],
    ["Duplicate without user-selected canonical", "excluded"],
    ["Alternate page with proper canonical tag", "excluded"],
    ["Page with redirect", "excluded"],
    ["Not found (404)", "excluded"],
    ["Soft 404", "excluded"],
    ["Server error (5xx)", "excluded"],
  ])("classifies %s as %s", (state, bucket) => {
    expect(classifyCoverageState(state)).toBe(bucket);
  });

  it("classifies a missing coverageState as other, not as a failure", () => {
    expect(classifyCoverageState(undefined)).toBe("other");
  });

  it("keeps discovered_not_indexed, crawled_not_indexed and indexed mutually distinct", () => {
    const results = new Set([
      classifyCoverageState("Discovered - currently not indexed"),
      classifyCoverageState("Crawled - currently not indexed"),
      classifyCoverageState("Submitted and indexed"),
    ]);
    expect(results.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------
describe("buildSummary", () => {
  it("aggregates per family and keeps discovered/crawled buckets distinct", () => {
    const byRoute: Record<string, RouteInspectionEntry> = {
      "https://x/1": { family: "facilities", coverageState: "Submitted and indexed" },
      "https://x/2": { family: "facilities", coverageState: "Discovered - currently not indexed" },
      "https://x/3": { family: "facilities", coverageState: "Crawled - currently not indexed" },
      "https://x/4": { family: "counties", coverageState: "URL is unknown to Google" },
    };
    const { byFamily } = buildSummary(byRoute);
    expect(byFamily.facilities).toEqual({
      inspected: 3,
      indexed: 1,
      discovered_not_indexed: 1,
      crawled_not_indexed: 1,
      excluded: 0,
      other: 0,
    });
    expect(byFamily.counties).toEqual({
      inspected: 1,
      indexed: 0,
      discovered_not_indexed: 0,
      crawled_not_indexed: 0,
      excluded: 0,
      other: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// computeInspectionSpan — pure derivation of earliest/latest inspectedAt
// ---------------------------------------------------------------------------
describe("computeInspectionSpan", () => {
  it("returns the earliest and latest inspectedAt across all records, regardless of insertion order", () => {
    const byRoute: Record<string, RouteInspectionEntry> = {
      "https://x/1": { family: "facilities", inspectedAt: "2026-09-20T10:00:05.000Z" },
      "https://x/2": { family: "facilities", inspectedAt: "2026-09-20T09:59:50.000Z" },
      "https://x/3": { family: "facilities", inspectedAt: "2026-09-20T10:00:12.000Z" },
    };
    expect(computeInspectionSpan(byRoute)).toEqual({
      firstInspectedAt: "2026-09-20T09:59:50.000Z",
      lastInspectedAt: "2026-09-20T10:00:12.000Z",
    });
  });

  it("returns undefined when no record carries an inspectedAt", () => {
    const byRoute: Record<string, RouteInspectionEntry> = {
      "https://x/1": { family: "facilities" },
    };
    expect(computeInspectionSpan(byRoute)).toBeUndefined();
  });

  it("returns undefined for an empty byRoute", () => {
    expect(computeInspectionSpan({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatDurationWords — plain-words elapsed duration
// ---------------------------------------------------------------------------
describe("formatDurationWords", () => {
  it("formats a sub-hour duration as minutes and seconds", () => {
    expect(formatDurationWords(11 * 60_000 + 42_000)).toBe("11m 42s");
  });

  it("switches to hours and minutes once the span exceeds an hour", () => {
    expect(formatDurationWords(2 * 3_600_000 + 5 * 60_000 + 1_000)).toBe("2h 5m");
  });

  it("switches to days and hours once the span exceeds a day", () => {
    expect(formatDurationWords(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });

  it("never goes negative", () => {
    expect(formatDurationWords(-500)).toBe("0m 0s");
  });
});

// ---------------------------------------------------------------------------
// reconcileSitemapTotals — candidates vs the sitemap's own parsed total.
// Must NEVER be fed totalInspected/selected — that is deliberately smaller
// (the stratified sample) and comparing it here would fire on every normal
// sampled run.
// ---------------------------------------------------------------------------
describe("reconcileSitemapTotals", () => {
  it("passes silently when candidates equal the parsed sitemap total", () => {
    expect(() => reconcileSitemapTotals(2997, 2997)).not.toThrow();
  });

  it("throws and names both numbers when candidates and the parsed total differ", () => {
    expect(() => reconcileSitemapTotals(2997, 2950)).toThrow(/2997/);
    expect(() => reconcileSitemapTotals(2997, 2950)).toThrow(/2950/);
  });

  // The regression this guards against: wiring `totalInspected` (the
  // stratified sample) into this check instead of the parsed sitemap total
  // would make it fire on every ordinary sampled run, since selected is
  // ALWAYS <= candidates by design.
  it("does not fire merely because the selected sample is smaller than the candidate total", () => {
    const families = [family("facilities", 2242)];
    const plan = buildCensusPlan(families, DEFAULT_TOTAL_TARGET);
    const parsedTotal = families.reduce((sum, f) => sum + f.urls.length, 0);
    expect(plan.totalInspected).toBeLessThan(plan.totalCandidates);
    expect(() => reconcileSitemapTotals(plan.totalCandidates, parsedTotal)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// main — dry run must make zero GSC calls; missing credential exits 0
// ---------------------------------------------------------------------------
describe("main", () => {
  const smallFamilyUrls = Array.from(
    { length: 3 },
    (_, i) => `https://www.compute-atlas.com/static-page-${i}`
  );
  const largeFamilyUrls = Array.from(
    { length: 100 },
    (_, i) => `https://www.compute-atlas.com/facilities/f-${i}`
  );

  let logSpy: ReturnType<typeof mockConsoleLog>;
  let fetchSpy: ReturnType<typeof stubFetch>;
  const printed = () => logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

  beforeEach(() => {
    logSpy = mockConsoleLog();
    fetchSpy = stubFetch((input) => {
      const url = String(input);
      if (url.endsWith("/sitemap.xml")) {
        return xmlResponse(
          sitemapIndexXml([
            "https://www.compute-atlas.com/sitemaps/static.xml",
            "https://www.compute-atlas.com/sitemaps/facilities.xml",
          ])
        );
      }
      if (url.endsWith("/sitemaps/static.xml")) return xmlResponse(urlsetXml(smallFamilyUrls));
      if (url.endsWith("/sitemaps/facilities.xml")) return xmlResponse(urlsetXml(largeFamilyUrls));
      throw new Error(`Unexpected fetch in main() test: ${url}`);
    });
  });

  // ⚠️ This is the test that protects the quota: a dry run must never touch
  // the URL Inspection API, the OAuth token endpoint, or even load
  // credentials. Mutating the default `run: false` to `true` should turn
  // this red.
  it("dry run (default) makes zero calls to inspection, token exchange, or credential loading", async () => {
    await main([]);
    expect(mockInspectUrl).not.toHaveBeenCalled();
    expect(mockFetchAccessToken).not.toHaveBeenCalled();
    expect(mockLoadCredentials).not.toHaveBeenCalled();
  });

  it("dry run prints the per-family plan, the quota share, and the output path", async () => {
    await main([]);
    const out = printed();
    expect(out).toContain("static");
    expect(out).toContain("facilities");
    expect(out).toContain("DRY RUN — no Search Console API calls were made");
    expect(out).toMatch(/% of the 2000\/day quota/);
    expect(out).toContain(OUTPUT_PATH);
  });

  // The untested throw path in main(): --family=<id> is a well-formed flag
  // (parseCliArgs accepts it), but no family in the fetched sitemap matches
  // it. This must throw naming the bad value and the real known families,
  // and must never reach credential loading or inspection.
  it("throws naming the unknown family and the known families when --family matches nothing in the sitemap", async () => {
    await expect(main(["--family=bogus"])).rejects.toThrow(
      /Unknown family "bogus"\. Known families: static, facilities/
    );
    expect(mockLoadCredentials).not.toHaveBeenCalled();
    expect(mockFetchAccessToken).not.toHaveBeenCalled();
    expect(mockInspectUrl).not.toHaveBeenCalled();
  });

  it("exits 0 with a notice when no credential is found, rather than throwing", async () => {
    mockLoadCredentials.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(main(["--run"])).rejects.toThrow("process.exit(0)");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockFetchAccessToken).not.toHaveBeenCalled();
    expect(mockInspectUrl).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // --sitemap override — reads routes from elsewhere, URL Inspection target
  // (SITE_URL) and the canonical sitemapIndexUrl identity stay unchanged.
  // ---------------------------------------------------------------------------
  describe("--sitemap override", () => {
    it("dry run with no --sitemap resolves the source to SITEMAP_INDEX_URL and prints it", async () => {
      await main([]);
      expect(fetchSpy.mock.calls.some(([input]) => String(input) === SITEMAP_INDEX_URL)).toBe(true);
      expect(printed()).toContain(`Sitemap source: ${SITEMAP_INDEX_URL}`);
    });

    it("dry run with --sitemap=<url> fetches the override, not the prod default, and prints it", async () => {
      const override = "http://localhost:3999/sitemap.xml";
      await main([`--sitemap=${override}`]);

      expect(fetchSpy.mock.calls.some(([input]) => String(input) === override)).toBe(true);
      expect(fetchSpy.mock.calls.some(([input]) => String(input) === SITEMAP_INDEX_URL)).toBe(false);
      expect(printed()).toContain(`Sitemap source: ${override}`);
      // sitemapIndexUrl — the canonical prod identity — is unaffected by the override.
      expect(printed()).toContain(`Sitemap index: ${SITEMAP_INDEX_URL}`);
    });

    it("rejects an invalid --sitemap before main() ever fetches anything", async () => {
      await expect(main(["--sitemap=notaurl"])).rejects.toThrow(
        /--sitemap must be an absolute http\(s\) URL/
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("records the resolved --sitemap source in the written report, alongside the unchanged sitemapIndexUrl", async () => {
      mockLoadCredentials.mockReturnValue({ client_email: "x", private_key: "y" });
      mockFetchAccessToken.mockResolvedValue("fake-token");
      mockInspectUrl.mockResolvedValue({
        inspectionUrl: "unused",
        indexStatusResult: { coverageState: "Submitted and indexed" },
      });

      const override = "http://localhost:3999/sitemap.xml";
      // --family=static keeps this to the 3-URL whole-family allocation so the
      // sequential inspect loop (with its real REQUEST_DELAY_MS sleep) stays fast.
      await main(["--run", "--family=static", `--sitemap=${override}`]);

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenBody] = mockWriteFileSync.mock.calls[0];
      expect(writtenPath).toBe(OUTPUT_PATH);
      const report = JSON.parse(String(writtenBody));
      expect(report.sitemapSource).toBe(override);
      expect(report.sitemapIndexUrl).toBe(SITEMAP_INDEX_URL);
    });
  });

  // ---------------------------------------------------------------------------
  // Per-record inspectedAt + span — an injected clock, never real wall-clock
  // timing (which would be flaky).
  // ---------------------------------------------------------------------------
  describe("per-record inspectedAt and span", () => {
    function stubInspection() {
      mockLoadCredentials.mockReturnValue({ client_email: "x", private_key: "y" });
      mockFetchAccessToken.mockResolvedValue("fake-token");
      mockInspectUrl.mockResolvedValue({
        inspectionUrl: "unused",
        indexStatusResult: { coverageState: "Submitted and indexed" },
      });
    }

    // A strictly-increasing fake clock — one second per call — so distinct
    // records are provably distinct without asserting on real elapsed time.
    function fakeClock() {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++ * 1000)).toISOString();
    }

    it("stamps each byRoute record with its own inspectedAt, distinct across records", async () => {
      stubInspection();
      // --family=static keeps this to the 3-URL whole-family allocation so the
      // sequential inspect loop (with its real REQUEST_DELAY_MS sleep) stays fast.
      await main(["--run", "--family=static"], { now: fakeClock() });

      const [, writtenBody] = mockWriteFileSync.mock.calls[0];
      const report = JSON.parse(String(writtenBody));
      const entries = Object.values(report.byRoute) as Array<{ inspectedAt: string }>;
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(entry.inspectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
      expect(new Set(entries.map((e) => e.inspectedAt)).size).toBe(3);
    });

    it("records a span matching the earliest/latest inspectedAt, and prints the elapsed duration in plain words", async () => {
      stubInspection();
      await main(["--run", "--family=static"], { now: fakeClock() });

      const [, writtenBody] = mockWriteFileSync.mock.calls[0];
      const report = JSON.parse(String(writtenBody));
      const timestamps = (Object.values(report.byRoute) as Array<{ inspectedAt: string }>)
        .map((e) => e.inspectedAt)
        .sort();
      expect(report.span.firstInspectedAt).toBe(timestamps[0]);
      expect(report.span.lastInspectedAt).toBe(timestamps[timestamps.length - 1]);
      // takenAt is stamped from the same injected clock, after every inspection.
      expect(report.takenAt >= report.span.lastInspectedAt).toBe(true);

      expect(printed()).toMatch(/Inspection span: .* -> .* \(inspected over \d+m \d+s\)/);
    });
  });
});
