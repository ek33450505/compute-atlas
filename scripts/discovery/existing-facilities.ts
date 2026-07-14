/**
 * Builds the compact {{EXISTING_FACILITIES}} projection injected into the
 * discovery prompt so claude can re-check existing facilities for genuine
 * status changes without needing the full facility doc for every record.
 *
 * One line per facility: `id | name | operator | status | <latest
 * statusHistory date> | <first source url>`. Kept compact (~100 chars/line)
 * so a large state (TX, ~43 facilities) stays well under 5KB.
 *
 * Run via: tsx scripts/discovery/existing-facilities.ts --state=TX
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, matching scripts/discovery/submit-candidates.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Facility } from "../../lib/schema";

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
 * Filters `facilities` by `location.state` and renders one compact
 * pipe-delimited line per match. Returns an empty string when there are no
 * matches (never throws on an empty/zero-facility state).
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
      ].join(" | ")
    )
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
  console.log(projection);
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
