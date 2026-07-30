/**
 * Builds the compact {{EXISTING_FACILITIES}} projection injected into the
 * discovery prompt so claude can re-check existing facilities for genuine
 * status changes without needing the full facility doc for every record.
 *
 * One line per facility: `id | name | operator | status | <latest
 * statusHistory date> | <first source url> | missing:<comma-separated
 * enrichable families, or "none">`. Kept compact (~100-150 chars/line) so a
 * large state (TX, ~43 facilities) stays well under 5KB.
 *
 * Also appends an optional dead-source block (`projectDeadSources`) sourced
 * from the most recent check-sources.ts report — facilities in the target
 * state with a `gone` (404/410/451) source, flagged for re-sourcing.
 *
 * Run via: tsx scripts/discovery/existing-facilities.ts --state=TX
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, matching scripts/discovery/submit-candidates.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { missingEnrichableFamilies } from "../../lib/enrichment-update";
import type { Facility } from "../../lib/schema";
import type { SourceCheckResult, SourceHealthReport } from "./check-sources";

/**
 * Latest statusHistory date, or lastUpdated if statusHistory is empty/absent.
 * Defensive against raw (non-zod-parsed) JSON where `statusHistory` may be
 * missing entirely — the schema's `.default([])` only applies via `.parse()`,
 * and the CLI's file fallback reads `data/facilities.json` with a bare
 * `JSON.parse`, matching submit-candidates.ts's loadExistingFacilities.
 */
function latestStatusDate(facility: Facility): string {
  const history = facility.statusHistory ?? [];
  if (history.length === 0) {
    return facility.lastUpdated;
  }
  return history.reduce((latest, event) => (event.date > latest ? event.date : latest), history[0].date);
}

/** First (primary) source URL for a facility. Defensive against a missing/empty `sources` array. */
function firstSourceUrl(facility: Facility): string {
  return facility.sources?.[0]?.url ?? "";
}

/**
 * Neutralizes characters that collide with the projection's own structural
 * delimiters (` | ` between fields, `\n` between rows) before a field is
 * joined into a line. A facility `name`/`operator`/url containing a literal
 * `|` or embedded CR/LF/tab would otherwise break the line-oriented format
 * or inject extra columns/lines into the discovery prompt that consumes this
 * block. Not a shell/injection defense (that's handled upstream) — purely
 * about the projection's own structural integrity.
 *
 * - `|` -> `/` (visually similar, can't be mistaken for the delimiter)
 * - CR/LF/tab -> single space
 * - runs of whitespace collapsed to one space, then trimmed
 */
function sanitizeField(value: string): string {
  return value
    .replaceAll("|", "/")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Filters `facilities` by `location.state` and renders one compact
 * pipe-delimited line per match. Returns an empty string when there are no
 * matches (never throws on an empty/zero-facility state). Every field is run
 * through `sanitizeField` so the ` | ` delimiter and `\n` row separator stay
 * the only structural pipes/newlines in the output.
 */
export function projectExisting(facilities: Facility[], state: string): string {
  return facilities
    .filter((facility) => facility.location?.state === state)
    .map((facility) =>
      [
        facility.id,
        facility.name,
        facility.operator,
        facility.status,
        latestStatusDate(facility),
        firstSourceUrl(facility),
        `missing:${missingEnrichableFamilies(facility).join(",") || "none"}`,
      ]
        .map(sanitizeField)
        .join(" | ")
    )
    .join("\n");
}

/**
 * Loads the most recent check-sources.ts report from `logDir` (or
 * `DISCOVERY_LOG_DIR`, or `<cwd>/discovery-logs`). Fail-open: returns `null`
 * on a missing directory, no matching report file, or a parse error — a
 * missing/corrupt report must never break the {{EXISTING_FACILITIES}} build.
 * Report filenames (`source-health-<ISO-timestamp-with-dashes>.json`) sort
 * chronologically as strings, so the lexicographically-greatest name is the
 * newest report.
 */
export function loadLatestSourceHealth(logDir?: string): SourceHealthReport | null {
  try {
    const dir = logDir ?? process.env.DISCOVERY_LOG_DIR ?? path.join(process.cwd(), "discovery-logs");
    const files = readdirSync(dir)
      .filter((name) => name.startsWith("source-health-") && name.endsWith(".json"))
      .sort();
    if (files.length === 0) {
      return null;
    }
    const latest = files[files.length - 1];
    const raw = readFileSync(path.join(dir, latest), "utf-8");
    return JSON.parse(raw) as SourceHealthReport;
  } catch {
    return null;
  }
}

/**
 * Renders a `id | url` line for every `gone` (404/410/451, genuinely dead)
 * source belonging to a facility in `state`, from the most recent
 * check-sources.ts report. Returns `""` when `report` is `null` or there are
 * no matches — the caller only prints the "DEAD SOURCES" header when this is
 * non-empty.
 */
export function projectDeadSources(facilities: Facility[], state: string, report: SourceHealthReport | null): string {
  if (!report) {
    return "";
  }
  const stateIds = new Set(
    facilities.filter((facility) => facility.location?.state === state).map((facility) => facility.id)
  );
  return report.results
    .filter((result: SourceCheckResult) => result.classification === "gone" && stateIds.has(result.facilityId))
    .map((result) => [result.facilityId, result.url].map(sanitizeField).join(" | "))
    .join("\n");
}

// --- CLI ---------------------------------------------------------------

function parseArgs(argv: string[]): { state?: string } {
  let state: string | undefined;
  for (const flag of argv) {
    if (flag.startsWith("--state=")) {
      state = flag.slice("--state=".length);
    }
  }
  return { state };
}

/**
 * Loads the live facility set — read API first, JSON file fallback.
 * Duplicated from scripts/discovery/submit-candidates.ts's
 * loadExistingFacilities (not refactored into a shared module — out of
 * scope for this feature, see plan Task A2).
 */
async function loadExistingFacilities(baseUrl: string): Promise<Facility[]> {
  try {
    const res = await fetch(`${baseUrl}/api/facilities`);
    if (res.ok) {
      const body = (await res.json()) as { facilities: Facility[] };
      return body.facilities;
    }
  } catch {
    // fall through to file fallback
  }

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  return JSON.parse(raw) as Facility[];
}

async function main(): Promise<void> {
  const { state } = parseArgs(process.argv.slice(2));
  if (!state) {
    console.error("Usage: tsx scripts/discovery/existing-facilities.ts --state=TX");
    process.exit(1);
  }

  const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
  const facilities = await loadExistingFacilities(baseUrl);
  const projection = projectExisting(facilities, state);

  const report = loadLatestSourceHealth();
  const deadBlock = projectDeadSources(facilities, state, report);

  if (deadBlock) {
    console.log(`${projection}\n\n=== DEAD SOURCES (re-source these) ===\n${deadBlock}`);
  } else {
    console.log(projection);
  }
}

// Only run main() when executed directly (not when imported by tests).
// Matches scripts/discovery/submit-candidates.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
