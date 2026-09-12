/**
 * Strips civil-division suffixes from `location.county` in data/facilities.json
 * — "Tulsa County" -> "Tulsa", "Rapides Parish" -> "Rapides" — so every record
 * stores the bare county name the way the other ~1,535 already do.
 *
 * WHY THIS EXISTS: data hygiene, not a bug fix. There is no user-visible
 * symptom, because `normalizeCounty` (lib/metros.ts) already defends matching
 * and `formatCountyLabel` already defends display, and `countySlug`
 * (lib/counties.ts) normalizes before slugging. The suffixed values are simply
 * inconsistent with the rest of the dataset.
 *
 * ⚠️ THIS IS A PREPARATION STEP. THE PUBLISH IS THE MAINTAINER'S.
 * data/facilities.json is a generated ARTIFACT of Neon, not an input to it.
 * Running this with --write leaves the repo in JSON↔Neon DRIFT until the
 * corrected values are published and re-exported. The full sequence is:
 *
 *   npx tsx scripts/normalize-county-suffixes.ts            # 1. review the plan
 *   npx tsx scripts/normalize-county-suffixes.ts --write    # 2. rewrite the JSON
 *   npm run db:sync                                         # 3. dry run — review
 *   npm run db:sync -- --apply                              # 4. PUBLISH (maintainer only)
 *   npm run db:export                                       # 5. regenerate the JSON from Neon
 *
 * Step 4 writes facility_history, busts cache tags, and can fire subscriber
 * notification email. Do not run it on someone else's behalf. Committing the
 * output of step 2 WITHOUT step 4 is the failure mode: neon-sync.yml would
 * then run db:export and open an auto-merged PR reverting the correction.
 *
 * Idempotent — after the publish and re-export this becomes a no-op and exits 0.
 *
 * Does NOT touch the two MO records spelling one county "St. Louis city" and
 * "St. Louis City". That is a CASE inconsistency, a different rule, and
 * `normalizeCounty` deliberately leaves a trailing " city" alone (an
 * independent city is a distinct place from the same-named county).
 *
 * Run: npx tsx scripts/normalize-county-suffixes.ts           (dry run — default)
 *      npx tsx scripts/normalize-county-suffixes.ts --write   (rewrites the file)
 *
 * Uses relative imports, matching scripts/check-neon-drift.ts and scripts/export.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { normalizeCounty } from "../lib/metros";
import type { Facility } from "../lib/schema";

const DATA_PATH = "data/facilities.json";

/** One record whose county spelling changes. */
export interface CountyChange {
  id: string;
  state: string;
  from: string;
  to: string;
}

/**
 * Pure transform: returns a new list with every `location.county` replaced by
 * its `normalizeCounty` form, plus the changes that produced it.
 *
 * Never mutates its argument — unchanged records are passed through by
 * reference, changed ones are shallow-cloned down to `location`. The suffix
 * rule itself is NOT reimplemented here: it is imported from lib/metros.ts, so
 * the script and the runtime can never disagree about what a county is called.
 */
export function normalizeCountiesIn(facilities: Facility[]): {
  facilities: Facility[];
  changes: CountyChange[];
} {
  const changes: CountyChange[] = [];

  const next = facilities.map((facility) => {
    const county = facility.location.county;
    if (county == null) return facility;

    const bare = normalizeCounty(county);
    if (bare === county) return facility;

    changes.push({
      id: facility.id,
      state: facility.location.state,
      from: county,
      to: bare,
    });
    return { ...facility, location: { ...facility.location, county: bare } };
  });

  return { facilities: next, changes };
}

/** Per-state counts, sorted count desc then state A→Z (deterministic). */
export function tallyByState(changes: CountyChange[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.state, (counts.get(change.state) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function main() {
  const write = process.argv.includes("--write");

  const original = readFileSync(DATA_PATH, "utf8");
  const facilities = JSON.parse(original) as Facility[];
  const { facilities: normalized, changes } = normalizeCountiesIn(facilities);

  console.log(`${DATA_PATH} — ${facilities.length} records`);

  if (changes.length === 0) {
    console.log("No county suffixes to normalize — nothing to do.");
    process.exit(0);
  }

  console.log(
    `\n${changes.length} record(s) with a civil-division suffix in location.county:\n`
  );
  for (const change of changes) {
    console.log(`  ${change.id}  ${change.state}  "${change.from}" -> "${change.to}"`);
  }

  console.log("\nPer state:");
  for (const [state, count] of tallyByState(changes)) {
    console.log(`  ${state}  ${count}`);
  }
  console.log(`  total  ${changes.length}`);

  if (!write) {
    console.log("\nDry run — nothing was written. Re-run with --write to apply.");
    process.exit(0);
  }

  // Matches scripts/export.ts's serialization exactly (2-space indent,
  // trailing newline). Verified byte-identical on a no-op round trip, so the
  // resulting diff contains only the changed county values — a reformatting
  // diff would swamp the real change and make the db:sync plan unreadable.
  writeFileSync(DATA_PATH, JSON.stringify(normalized, null, 2) + "\n", "utf-8");

  console.log(`\nWrote ${changes.length} correction(s) to ${DATA_PATH}.`);
  console.log(
    "⚠️  The repo is now in JSON↔Neon drift. Publish with `npm run db:sync` " +
      "(review the plan) then `npm run db:sync -- --apply`, and re-export with " +
      "`npm run db:export`. Do not commit this file without publishing."
  );
  process.exit(0);
}

// Guarded so importing this module from the test suite does not run the CLI —
// matches scripts/export.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
