/**
 * Append-only, summary-level history for the index census — one line per
 * frozen baseline (`scripts/census-baseline.ts`) or diff run
 * (`scripts/census-diff.ts`), NEVER per-URL (that would grow without bound).
 *
 * This is what turns a single census into the TIME SERIES the
 * `seo-index-census` skill requires: a one-off look cannot distinguish "just
 * regressed" from "never crawled" — only movement recorded across multiple
 * entries here can. Each line keeps only the four per-family counts that
 * matter for that distinction (inspected/indexed/discovered_not_indexed/
 * crawled_not_indexed); `excluded`/`other` are intentionally dropped.
 *
 * Appending NEVER rewrites or truncates prior lines — it only ever READS the
 * existing file (to report, not repair, corruption) and then appends via
 * `appendFileSync`. If an existing line is corrupt/unparseable JSON, it is
 * skipped with a stderr warning rather than aborting the append: a bad
 * historical line must never block recording a new one, and it is left
 * exactly as it was in the file, never rewritten or dropped.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { IndexCensusReport } from "./index-census";

export const HISTORY_PATH = join(process.cwd(), "data", "index-census-history.jsonl");

// Single source for the baseline path — imported by scripts/census-baseline.ts
// and scripts/census-diff.ts, mirroring how scripts/index-census.ts is the
// single source for OUTPUT_PATH. Pure hoist: the path value is unchanged.
export const BASELINE_PATH = join(process.cwd(), "data", "index-census-baseline.json");

export interface CensusHistoryFamilyEntry {
  inspected: number;
  indexed: number;
  discovered_not_indexed: number;
  crawled_not_indexed: number;
}

export interface CensusHistoryEntry {
  takenAt: string;
  sitemapSource: string;
  span?: { firstInspectedAt: string; lastInspectedAt: string };
  byFamily: Record<string, CensusHistoryFamilyEntry>;
}

/**
 * Builds a summary-level history entry from a full census report. Reuses
 * `report.summary.byFamily` (built by `scripts/index-census.ts`'s
 * `buildSummary`) rather than re-deriving counts from `byRoute` — one source
 * of truth for what "indexed" / "discovered_not_indexed" / etc. mean.
 */
export function buildHistoryEntry(report: IndexCensusReport): CensusHistoryEntry {
  const byFamily: Record<string, CensusHistoryFamilyEntry> = {};
  for (const [family, summary] of Object.entries(report.summary.byFamily)) {
    byFamily[family] = {
      inspected: summary.inspected,
      indexed: summary.indexed,
      discovered_not_indexed: summary.discovered_not_indexed,
      crawled_not_indexed: summary.crawled_not_indexed,
    };
  }
  return { takenAt: report.takenAt, sitemapSource: report.sitemapSource, span: report.span, byFamily };
}

/**
 * Appends one entry to the history file at `historyPath`. See the module
 * header: this never rewrites or truncates prior content, and a corrupt
 * existing line is reported (stderr) and skipped, never fatal.
 */
export function appendCensusHistory(entry: CensusHistoryEntry, historyPath: string = HISTORY_PATH): void {
  let needsLeadingNewline = false;
  if (existsSync(historyPath)) {
    const existingContent = readFileSync(historyPath, "utf8");
    const existingLines = existingContent.split("\n").filter((line) => line.trim().length > 0);
    existingLines.forEach((line, i) => {
      try {
        JSON.parse(line);
      } catch {
        console.error(
          `Warning: history line ${i + 1} in ${historyPath} is not valid JSON — skipping it for this ` +
            "check, leaving it in place, and still appending the new entry."
        );
      }
    });
    // Guard against corrupting the entry we are ABOUT TO WRITE — this is
    // distinct from (and in addition to) tolerating a pre-existing corrupt
    // line, handled above. A prior write can be interrupted mid-flush,
    // leaving the file's last byte as something other than "\n": a truncated
    // fragment, not a clean line. Appending directly onto that fragment does
    // not merely leave the OLD fragment corrupt — it glues our new, valid
    // JSON onto it, producing ONE unparseable line and silently destroying
    // the entry being recorded RIGHT NOW. Do not simplify this away in a
    // later refactor: the failure mode being prevented is corruption of the
    // NEW entry, not just tolerance of an old one.
    if (existingContent.length > 0 && !existingContent.endsWith("\n")) {
      needsLeadingNewline = true;
    }
  }
  const chunk = (needsLeadingNewline ? "\n" : "") + JSON.stringify(entry) + "\n";
  appendFileSync(historyPath, chunk);
}
