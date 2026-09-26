/**
 * Index-census diff — compares the CURRENT index census
 * (`data/index-census.json`, written by `scripts/index-census.ts`) against a
 * previously frozen baseline (`data/index-census-baseline.json`, written by
 * `scripts/census-baseline.ts`) and reports per-family movement.
 *
 * Why this exists: a one-off census cannot distinguish "just regressed" from
 * "never crawled" — only a comparison across two points in time can. This is
 * that comparison. Rules this file must never violate (see the
 * `seo-index-census` skill):
 *
 *  - `Discovered - currently not indexed` and `Crawled - currently not
 *    indexed` have DIFFERENT causes (crawl budget vs. content quality) and
 *    must be reported in separate buckets, never merged. See
 *    `computeCensusDiff` below — this is the specific misdiagnosis this
 *    file's mutation test targets.
 *  - Never report a per-stratum (sampled-panel) rate as a site-wide rate —
 *    every number here describes the sampled panel, not the whole site.
 *
 * ## The panel is assumed stable, and drift is surfaced, never hidden
 *
 * `scripts/index-census.ts` samples a DETERMINISTIC stratified panel (a
 * stable stride over sorted URLs — see `selectStratifiedSample` there), so
 * two censuses re-inspect the SAME URLs. That stability is what makes a diff
 * meaningful. If the sitemap's URL set changed between the two censuses,
 * the panel will have moved — this script does NOT silently intersect the
 * two URL sets and report movement only for the overlap; it computes
 * movement for the overlap AND separately surfaces every URL present in only
 * one census as `panelDrift`, so a moved panel is visible, not quietly
 * assumed away.
 *
 * ## The falsifiable check
 *
 * A PASSING diff means every URL present in BOTH censuses was classified
 * into exactly one of {newly indexed, newly dropped, still
 * discovered-not-indexed, still crawled-not-indexed, no change} and the
 * panel overlap (URLs present in only one side) is accounted for in
 * `panelDrift`. It is NOT a claim that coverage improved, and none of these
 * numbers are a site-wide indexing rate — see the header notes above.
 *
 * Read-only with respect to its two inputs: this script never writes the
 * census or the baseline file. It DOES append a summary-level entry to the
 * append-only history log (see `./census-history`) — that is a distinct
 * file from either input, and appending to it is exactly what turns
 * point-in-time censuses into the time series the `seo-index-census` skill
 * requires.
 *
 * Usage:
 *   npm run census:diff              # human-readable table
 *   npm run census:diff -- --json    # machine-readable JSON
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { existsSync, readFileSync } from "node:fs";

import { appendCensusHistory, BASELINE_PATH, buildHistoryEntry, HISTORY_PATH } from "./census-history";
import { classifyCoverageState, OUTPUT_PATH, type IndexCensusReport } from "./index-census";

export interface FamilyDiff {
  /** Was not indexed in the baseline, is indexed now. */
  newlyIndexed: string[];
  /** Was indexed in the baseline, is not indexed now. */
  newlyDropped: string[];
  /** Discovered-but-not-indexed in BOTH censuses — the crawl-budget backlog. Never merged with the bucket below. */
  stillDiscoveredNotIndexed: string[];
  /** Crawled-but-not-indexed in BOTH censuses — the content-quality backlog. Never merged with the bucket above. */
  stillCrawledNotIndexed: string[];
}

export interface CensusDiffResult {
  baselineTakenAt: string;
  currentTakenAt: string;
  baselineSitemapSource: string;
  currentSitemapSource: string;
  families: Record<string, FamilyDiff>;
  /**
   * URLs present in one census's `byRoute` but not the other. The sampled
   * panel is supposed to be deterministic and stable across runs (see the
   * module header) — a non-empty set here means the panel itself moved
   * (e.g. the sitemap's URL set changed), which is a signal to investigate,
   * not a count to fold silently into the totals above.
   */
  panelDrift: {
    onlyInBaseline: string[];
    onlyInCurrent: string[];
  };
}

function emptyFamilyDiff(): FamilyDiff {
  return { newlyIndexed: [], newlyDropped: [], stillDiscoveredNotIndexed: [], stillCrawledNotIndexed: [] };
}

/**
 * Pure comparison — the core of this script. Classifies every URL present in
 * BOTH censuses' `byRoute` via `classifyCoverageState` (the same
 * classification `scripts/index-census.ts` uses to build its own summary —
 * reused here, never redeclared) and buckets its movement. A URL present in
 * only one side is never guessed at here; it is collected into `panelDrift`
 * instead (see the module header).
 */
export function computeCensusDiff(baseline: IndexCensusReport, current: IndexCensusReport): CensusDiffResult {
  const baselineUrls = new Set(Object.keys(baseline.byRoute));
  const currentUrls = new Set(Object.keys(current.byRoute));

  const families: Record<string, FamilyDiff> = {};

  for (const url of baselineUrls) {
    if (!currentUrls.has(url)) continue; // panel drift — handled separately below, never guessed at here
    const baseEntry = baseline.byRoute[url];
    const curEntry = current.byRoute[url];
    const family = curEntry.family;
    const diff = (families[family] ??= emptyFamilyDiff());

    const baseBucket = classifyCoverageState(baseEntry.coverageState);
    const curBucket = classifyCoverageState(curEntry.coverageState);

    const wasIndexed = baseBucket === "indexed";
    const isIndexed = curBucket === "indexed";
    if (!wasIndexed && isIndexed) diff.newlyIndexed.push(url);
    else if (wasIndexed && !isIndexed) diff.newlyDropped.push(url);

    // Kept as two INDEPENDENT checks, each pushing to its own array — never
    // a shared branch/array. Merging these is the exact misdiagnosis this
    // file's mutation test guards against: crawl budget and content quality
    // are different causes and must stay distinguishable.
    if (baseBucket === "discovered_not_indexed" && curBucket === "discovered_not_indexed") {
      diff.stillDiscoveredNotIndexed.push(url);
    }
    if (baseBucket === "crawled_not_indexed" && curBucket === "crawled_not_indexed") {
      diff.stillCrawledNotIndexed.push(url);
    }
  }

  for (const diff of Object.values(families)) {
    diff.newlyIndexed.sort();
    diff.newlyDropped.sort();
    diff.stillDiscoveredNotIndexed.sort();
    diff.stillCrawledNotIndexed.sort();
  }

  return {
    baselineTakenAt: baseline.takenAt,
    currentTakenAt: current.takenAt,
    baselineSitemapSource: baseline.sitemapSource,
    currentSitemapSource: current.sitemapSource,
    families,
    panelDrift: {
      onlyInBaseline: [...baselineUrls].filter((u) => !currentUrls.has(u)).sort(),
      onlyInCurrent: [...currentUrls].filter((u) => !baselineUrls.has(u)).sort(),
    },
  };
}

export interface CliOptions {
  json: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const unknown = argv.filter((a) => a !== "--json");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}. Known flags: --json`);
  }
  return { json: argv.includes("--json") };
}

function loadReport(path: string, notFoundMessage: string): IndexCensusReport {
  if (!existsSync(path)) {
    throw new Error(`${notFoundMessage} (expected at ${path})`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as IndexCensusReport;
}

function printDiffTable(diff: CensusDiffResult): void {
  console.log("Index census diff");
  console.log(`Baseline: ${diff.baselineTakenAt} (${diff.baselineSitemapSource})`);
  console.log(`Current:  ${diff.currentTakenAt} (${diff.currentSitemapSource})\n`);
  console.log(
    "family".padEnd(16) +
      "newly idx".padStart(11) +
      "newly drop".padStart(12) +
      "still disc".padStart(12) +
      "still crawl".padStart(13)
  );
  const families = Object.entries(diff.families).sort(([a], [b]) => a.localeCompare(b));
  for (const [family, f] of families) {
    console.log(
      family.padEnd(16) +
        String(f.newlyIndexed.length).padStart(11) +
        String(f.newlyDropped.length).padStart(12) +
        String(f.stillDiscoveredNotIndexed.length).padStart(12) +
        String(f.stillCrawledNotIndexed.length).padStart(13)
    );
  }

  const { onlyInBaseline, onlyInCurrent } = diff.panelDrift;
  if (onlyInBaseline.length > 0 || onlyInCurrent.length > 0) {
    console.log(
      `\n⚠️  Panel drift detected — the sampled panel should be stable across runs, but ` +
        `${onlyInBaseline.length} URL(s) are only in the baseline and ${onlyInCurrent.length} are only in the ` +
        "current census. Investigate before trusting the movement counts above."
    );
    if (onlyInBaseline.length > 0) console.log(`  Only in baseline: ${onlyInBaseline.join(", ")}`);
    if (onlyInCurrent.length > 0) console.log(`  Only in current:  ${onlyInCurrent.join(", ")}`);
  }

  console.log(
    "\nNOTE: a passing diff means every URL present in both censuses was classified — this is NOT a " +
      "verdict that coverage improved, and every count above describes the sampled panel, not the whole site."
  );
}

export async function main(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);
  const baseline = loadReport(BASELINE_PATH, "No baseline found. Run `npm run census:baseline` first");
  const current = loadReport(OUTPUT_PATH, "No census found. Run `npm run census -- --run` first");

  const diff = computeCensusDiff(baseline, current);

  if (options.json) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    printDiffTable(diff);
  }

  // Summary-level only — see ./census-history. Recorded regardless of
  // --json/table mode; this is what builds the time series over repeated
  // diff runs. Never writes/touches the census or baseline files above.
  appendCensusHistory(buildHistoryEntry(current), HISTORY_PATH);
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches scripts/index-census.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
