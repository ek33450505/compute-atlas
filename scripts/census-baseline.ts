/**
 * Freezes the CURRENT index census (`data/index-census.json`, written by
 * `scripts/index-census.ts`) as the comparison baseline
 * (`data/index-census-baseline.json`) that `scripts/census-diff.ts` diffs
 * every later census against.
 *
 * Why a separate freeze step, rather than always diffing against "the last
 * census": the `seo-index-census` skill requires a TIME SERIES, and a time
 * series needs a fixed starting point that does not silently move underneath
 * you. Freezing is a deliberate act (mirrors `db:sync`'s dry-run-by-default /
 * `--apply` posture elsewhere in this repo): this refuses loudly if there is
 * no census to freeze, and refuses to silently clobber an existing baseline
 * — an accidental re-freeze would destroy the only record of where the
 * measurement started, with no way to recover it. Pass --replace once that
 * is a deliberate choice, not a default.
 *
 * This never modifies `data/index-census.json` — it only reads it and copies
 * its exact bytes to the baseline path, so the baseline is a byte-identical
 * freeze, not a re-serialization.
 *
 * Usage:
 *   npm run census:baseline               # freeze; refuses if a baseline already exists
 *   npm run census:baseline -- --replace  # deliberately overwrite an existing baseline
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { appendCensusHistory, BASELINE_PATH, buildHistoryEntry, HISTORY_PATH } from "./census-history";
import { OUTPUT_PATH, type IndexCensusReport } from "./index-census";

export interface CliOptions {
  /** Deliberately overwrite an existing baseline. Default false — see the posture note above. */
  replace: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const unknown = argv.filter((a) => a !== "--replace");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}. Known flags: --replace`);
  }
  return { replace: argv.includes("--replace") };
}

function printFrozen(report: IndexCensusReport): void {
  console.log(`Froze baseline from census taken at ${report.takenAt}`);
  console.log(`Sitemap source: ${report.sitemapSource}`);
  console.log(`Written to: ${BASELINE_PATH}\n`);
  console.log(
    "family".padEnd(16) + "inspected".padStart(11) + "indexed".padStart(10) +
      "discovered".padStart(13) + "crawled".padStart(10)
  );
  const families = Object.entries(report.summary.byFamily).sort(([a], [b]) => a.localeCompare(b));
  for (const [family, s] of families) {
    console.log(
      family.padEnd(16) +
        String(s.inspected).padStart(11) +
        String(s.indexed).padStart(10) +
        String(s.discovered_not_indexed).padStart(13) +
        String(s.crawled_not_indexed).padStart(10)
    );
  }
}

/**
 * Refuses to freeze a report that stopped early (`partial: true` — see
 * `IndexCensusReport` in `./index-census`) as a baseline. A partial report's
 * per-family counts are truncated at whatever point the run died, so
 * freezing one would bake a false starting point into every future
 * measurement. Deliberately no `--force`-style escape: there is no
 * legitimate reason to want a truncated baseline. Factual on purpose — the
 * partial report is still on disk, so this never implies data was lost.
 *
 * `report.partial` is checked with `=== true` (never a bare truthy check on
 * some other field) so a report with `partial: false` or the field absent —
 * both possible once JSON.parse crosses the type-checked boundary — is
 * correctly treated as complete, not refused.
 */
function assertCensusNotPartial(report: IndexCensusReport): void {
  if (report.partial !== true) return;
  const covered = Object.keys(report.byRoute).length;
  const planned = report.sampled.totalInspected;
  throw new Error(
    `The census at ${OUTPUT_PATH} is PARTIAL — it covered ${covered}/${planned} planned URL(s) before ` +
      `stopping early (reason: ${report.partialReason ?? "(no reason recorded)"}). A partial census cannot ` +
      "be frozen as a baseline: its per-family counts are truncated at whatever point the run died, and " +
      "freezing it would bake a false starting point into every future measurement. Nothing was lost — the " +
      "partial report is still on disk. Re-run the census to completion (`npm run census -- --run`) and " +
      "then retry `npm run census:baseline`."
  );
}

export async function main(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);

  if (!existsSync(OUTPUT_PATH)) {
    throw new Error(
      `No census found at ${OUTPUT_PATH}. Run \`npm run census -- --run\` first, then freeze a baseline.`
    );
  }
  if (existsSync(BASELINE_PATH) && !options.replace) {
    throw new Error(
      `A baseline already exists at ${BASELINE_PATH}. Re-run with --replace to overwrite it deliberately — ` +
        "silently overwriting the comparison basis would destroy the only record of where this measurement started."
    );
  }

  const raw = readFileSync(OUTPUT_PATH, "utf8");
  const report = JSON.parse(raw) as IndexCensusReport;
  assertCensusNotPartial(report);

  writeFileSync(BASELINE_PATH, raw);
  printFrozen(report);
  appendCensusHistory(buildHistoryEntry(report), HISTORY_PATH);
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
