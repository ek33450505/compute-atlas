import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import { normalizeCounty } from "@/lib/metros";
import { countySlug } from "./counties";

// Real-dataset half (DATASET=real). The default run applies the same check to
// the committed fixture in counties.test.ts; only the real file can prove a
// production data wave did not introduce a slug collision.
describe("data-integrity: county slug uniqueness", () => {
  // The guard this file exists for. `countySlug` is lossy by design — it
  // strips civil-division suffixes and apostrophes, and collapses every other
  // run of punctuation to a single separator — so a future data
  // wave that adds e.g. "St Louis" (no period) next to "St. Louis", or drops
  // the state suffix from the rule, would silently merge two genuinely
  // different counties onto one hub with one wrong facility count. Nothing
  // else in the pipeline would notice.
  //
  // Mutation-tested: deleting the `-${state}` suffix from countySlug fails
  // this on "Washington" alone (a county in OR, NE, OH, TN, GA, PA, LA, MS
  // and UT).
  it("maps no two distinct (state, county) pairs to the same slug", () => {
    const facilities = facilitiesRaw as Array<{
      location: { state: string; county?: string | null };
    }>;

    const pairsBySlug = new Map<string, Set<string>>();
    for (const facility of facilities) {
      const county = facility.location.county;
      if (county == null || county.trim() === "") continue;
      const state = facility.location.state.toUpperCase();
      const slug = countySlug(county, state);
      const pair = `${state}|${normalizeCounty(county).toLowerCase()}`;
      const seen = pairsBySlug.get(slug);
      if (seen) seen.add(pair);
      else pairsBySlug.set(slug, new Set([pair]));
    }

    const collisions = [...pairsBySlug]
      .filter(([, pairs]) => pairs.size > 1)
      .map(([slug, pairs]) => `${slug} <- ${[...pairs].sort().join(" + ")}`);

    if (collisions.length > 0) {
      throw new Error(
        `${collisions.length} county slug collision${collisions.length === 1 ? "" : "s"} in ` +
          `data/facilities.json — distinct counties would share one /counties hub and one ` +
          `facility count: ${collisions.slice(0, 10).join("; ")}` +
          `${collisions.length > 10 ? `, and ${collisions.length - 10} more` : ""}. ` +
          "Either the new county spelling needs normalizing in the data, or countySlug is " +
          "over-collapsing. Do not widen the slug rule to make this pass.",
      );
    }

    expect(collisions).toEqual([]);
    // Sanity floor: the guard is worthless if it silently scans nothing.
    expect(pairsBySlug.size).toBeGreaterThan(500);
  });
});
