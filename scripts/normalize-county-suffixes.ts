/**
 * Corrects `location.county` in data/facilities.json under TWO independent
 * rules, kept deliberately separate in code and in the printed report:
 *
 *   1. SUFFIX — strips civil-division suffixes: "Tulsa County" -> "Tulsa",
 *      "Rapides Parish" -> "Rapides" — so every record stores the bare
 *      county name the way the other ~1,535 already do.
 *   2. CASE — corrects the casing of a KNOWN independent-city
 *      county-equivalent name: "St. Louis City" -> "St. Louis city".
 *
 * WHY THIS EXISTS: data hygiene, not a bug fix. There is no user-visible
 * symptom, because `normalizeCounty` (lib/metros.ts) already defends matching
 * and `formatCountyLabel` already defends display, and `countySlug`
 * (lib/counties.ts) normalizes before slugging. The values are simply
 * inconsistent with the rest of the dataset.
 *
 * WHY RULE 2 IS AN ALLOWLIST, NOT A REGEX: a blanket "lowercase any trailing
 * 'city' word" rule looks tempting but is unsafe — Census also has ordinary
 * counties whose PROPER name ends in "City" (e.g. Virginia's James City
 * County, which rule 1's suffix strip reduces to "James City" — capitalized
 * correctly, because that IS the county's real name, not a case bug). A
 * regex can't tell "the county is legitimately named ...City" apart from
 * "this independent city's descriptor is mis-cased"; only a name-specific
 * allowlist can. So rule 2 only ever touches the exact names below,
 * regardless of future data — it cannot silently re-case an unrelated county.
 *
 * CANONICAL FORM: lowercase "city" — chosen from two lines of evidence, not
 * invented: (a) Census/FIPS convention renders independent-city
 * county-equivalents with a lowercase "city" (e.g. the Census QuickFacts page
 * is titled "St. Louis city, Missouri"); (b) this dataset already agrees —
 * "Baltimore city" (both MD records) and "St. Louis city" already use
 * lowercase "city", and "St. Louis City" is the sole 1-of-4 outlier. If that
 * evidence is ever disputed, the fix is a one-line edit to
 * `KNOWN_CITY_COUNTY_EQUIVALENTS` below.
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
 * Run: npx tsx scripts/normalize-county-suffixes.ts           (dry run — default)
 *      npx tsx scripts/normalize-county-suffixes.ts --write   (rewrites the file)
 *
 * Uses relative imports, matching scripts/check-neon-drift.ts and scripts/export.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { normalizeCounty } from "../lib/metros";
import type { Facility } from "../lib/schema";

const DATA_PATH = "data/facilities.json";

/** Which of the two independent rules produced a given change. */
export type CountyChangeKind = "suffix" | "case";

/** One record whose county spelling changes, and which rule did it. */
export interface CountyChange {
  id: string;
  state: string;
  from: string;
  to: string;
  kind: CountyChangeKind;
}

/**
 * Canonical spelling for KNOWN independent-city county-equivalents whose
 * casing has been observed to vary in the wild data. Keyed by
 * `STATE|lowercased-input` so lookup is case-insensitive on the input side
 * but the stored value is exact. Deliberately a short, explicit allowlist —
 * see the file doc comment for why a regex is unsafe here.
 *
 * Including "Baltimore city" even though it never currently needs correcting
 * is intentional: it documents the canonical form and guards a future
 * mis-cased Baltimore record the same way St. Louis's was caught.
 */
const KNOWN_CITY_COUNTY_EQUIVALENTS: Record<string, string> = {
  "MO|st. louis city": "St. Louis city",
  "MD|baltimore city": "Baltimore city",
};

/**
 * Case-only correction for a county value that exactly matches (up to case)
 * a known independent-city name. Returns `raw` unchanged for anything not in
 * `KNOWN_CITY_COUNTY_EQUIVALENTS` — including the correctly-cased entries
 * themselves, and every ordinary county name, known or not.
 */
export function normalizeCountyCase(raw: string, state: string): string {
  const key = `${state.toUpperCase()}|${raw.toLowerCase()}`;
  return KNOWN_CITY_COUNTY_EQUIVALENTS[key] ?? raw;
}

/**
 * Pure transform: returns a new list with every `location.county` passed
 * through the suffix rule THEN the case rule, plus the changes that produced
 * it (each tagged with which rule made it).
 *
 * Never mutates its argument — unchanged records are passed through by
 * reference, changed ones are shallow-cloned down to `location`. Neither rule
 * is reimplemented here: `normalizeCounty` comes from lib/metros.ts and the
 * case allowlist is scoped above, so the script and the runtime can never
 * disagree about what a county is called.
 *
 * The two rules are disjoint by construction — rule 1 only fires on a
 * trailing County/Parish/Borough suffix, rule 2 only fires on an exact
 * allowlisted independent-city name, and no allowlisted name ends in one of
 * those suffix words — so no real record is ever touched by both. Applying
 * them in sequence (suffix, then case, on the suffix rule's own output) still
 * composes correctly for the hypothetical case where a record needs both,
 * without double-counting or looping: see the "composes without
 * double-transforming" test in the spec file.
 */
export function normalizeCountiesIn(facilities: Facility[]): {
  facilities: Facility[];
  changes: CountyChange[];
} {
  const changes: CountyChange[] = [];

  const next = facilities.map((facility) => {
    const county = facility.location.county;
    if (county == null) return facility;

    let value = county;

    const suffixStripped = normalizeCounty(value);
    if (suffixStripped !== value) {
      changes.push({
        id: facility.id,
        state: facility.location.state,
        from: value,
        to: suffixStripped,
        kind: "suffix",
      });
      value = suffixStripped;
    }

    const caseFixed = normalizeCountyCase(value, facility.location.state);
    if (caseFixed !== value) {
      changes.push({
        id: facility.id,
        state: facility.location.state,
        from: value,
        to: caseFixed,
        kind: "case",
      });
      value = caseFixed;
    }

    if (value === county) return facility;
    return { ...facility, location: { ...facility.location, county: value } };
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
    console.log("No county corrections to apply — nothing to do.");
    process.exit(0);
  }

  // Reported separately by design — see the file doc comment. Each list and
  // its per-state tally stands alone so "expect exactly 26 suffix changes"
  // stays independently verifiable regardless of what rule 2 finds.
  const suffixChanges = changes.filter((c) => c.kind === "suffix");
  const caseChanges = changes.filter((c) => c.kind === "case");

  console.log(
    `\n[RULE 1 — SUFFIX] ${suffixChanges.length} record(s) with a civil-division suffix in location.county:\n`
  );
  for (const change of suffixChanges) {
    console.log(`  ${change.id}  ${change.state}  "${change.from}" -> "${change.to}"`);
  }
  if (suffixChanges.length > 0) {
    console.log("\nPer state:");
    for (const [state, count] of tallyByState(suffixChanges)) {
      console.log(`  ${state}  ${count}`);
    }
    console.log(`  total  ${suffixChanges.length}`);
  }

  console.log(
    `\n[RULE 2 — CASE] ${caseChanges.length} record(s) with a county-name case correction in location.county:\n`
  );
  for (const change of caseChanges) {
    console.log(`  ${change.id}  ${change.state}  "${change.from}" -> "${change.to}"`);
  }
  if (caseChanges.length > 0) {
    console.log("\nPer state:");
    for (const [state, count] of tallyByState(caseChanges)) {
      console.log(`  ${state}  ${count}`);
    }
    console.log(`  total  ${caseChanges.length}`);
  }

  console.log(`\nCombined total: ${changes.length} correction(s).`);

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
