/**
 * Dependency-free leaf module for the by-county lens — deliberately imports
 * only two other leaves (`lib/metros.ts`, which has zero imports, and
 * `lib/operator-slug.ts`, which has zero imports), and never `next/*` or
 * `lib/data.ts`. Same reasoning as `lib/operator-slug.ts`'s header comment:
 * route files, the sitemap, bare `tsx` CLIs and unit tests all need the slug
 * rule, and none of them should drag in the Next.js runtime or the data
 * layer's caching/DB machinery just to build a URL. `lib/data.ts` re-exports
 * `countySlug` so app code can keep importing from one module.
 */

import { normalizeCounty } from "@/lib/metros";
import { slugify } from "@/lib/operator-slug";

/**
 * URL slug for a (county, state) pair, e.g. ("Loudoun County","VA") -> "loudoun-va".
 *
 * Two deliberate steps, both load-bearing:
 *
 * 1. Apostrophes are stripped BEFORE slugifying, because `slugify` collapses
 *    every run of non-alphanumerics to "-" and would otherwise treat a bare
 *    apostrophe as a separator: "Prince George's" → `prince-george-s` instead
 *    of the live `prince-georges-md`. Periods need no special handling and are
 *    deliberately NOT stripped — `slugify` already collapses ". " into the one
 *    separator the name wants ("St. Louis" → `st-louis`), and stripping the
 *    period first would turn an unspaced "St.Louis" into the worse `stlouis`.
 *    Measured: removing "." from this class changes 0 of the 636 live slugs.
 * 2. The `-<state>` suffix is mandatory, not decoration: county names repeat
 *    across states — "Washington" is a county in OR, UT and WA — so a bare
 *    county slug is not unique and would silently merge distinct counties
 *    onto one hub. `lib/counties.test.ts` guards this with a collision
 *    assertion over the whole live dataset.
 *
 * `normalizeCounty` runs first so the live data's mixed `"X County"` /
 * `"X Parish"` / bare `"X"` spellings all land on the same slug. It
 * deliberately does not strip a trailing ` city`, so independent cities stay
 * distinct from the same-named county (`st-louis-mo` vs `st-louis-city-mo`).
 *
 * Never parse a slug back apart to recover (county, state) — resolve it
 * through a reverse index built from the data (`getCountyBySlug` in
 * `lib/data.ts`), the way operator slugs resolve.
 */
export function countySlug(county: string, state: string): string {
  return `${slugify(normalizeCounty(county).replace(/['’]/g, ""))}-${state.toLowerCase()}`;
}

/**
 * Picks one display spelling when the data disagrees: the most frequent
 * spelling, ties broken by `localeCompare` ascending.
 *
 * Real case in the live data — MO carries both `"St. Louis city"` and
 * `"St. Louis City"`, which normalize to one county and one slug but two
 * candidate labels. Choosing by array order alone would make the rendered
 * page depend on sort order elsewhere in the pipeline; this is deterministic
 * for any input permutation. Returns "" for an empty input.
 */
export function canonicalCountyName(spellings: string[]): string {
  const counts = new Map<string, number>();
  for (const s of spellings) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [spelling, count] of counts) {
    if (count > bestCount || (count === bestCount && spelling.localeCompare(best) < 0)) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}
