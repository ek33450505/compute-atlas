import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import { normalizeCounty } from "@/lib/metros";
import { canonicalCountyName, countySlug } from "./counties";

describe("countySlug", () => {
  // Every row of the agreed slug table. These are the contract: changing any
  // of them changes a live URL.
  it.each([
    ["Loudoun", "VA", "loudoun-va"],
    ["Loudoun County", "VA", "loudoun-va"],
    ["Rapides Parish", "LA", "rapides-la"],
    ["Prince George's", "MD", "prince-georges-md"],
    ["St. Louis", "MN", "st-louis-mn"],
    ["St. Louis city", "MO", "st-louis-city-mo"],
    ["St. Louis City", "MO", "st-louis-city-mo"],
    ["Miami-Dade", "FL", "miami-dade-fl"],
    ["Chesapeake (independent city)", "VA", "chesapeake-independent-city-va"],
    ["Salt Lake", "UT", "salt-lake-ut"],
  ])("slugs (%s, %s) as %s", (county, state, expected) => {
    expect(countySlug(county, state)).toBe(expected);
  });

  it("drops apostrophes rather than slugging them to a separator", () => {
    // "prince-george-s" is what you get if slugify sees the apostrophe.
    expect(countySlug("Prince George's", "MD")).not.toContain("-s-");
    // The typographic apostrophe is handled identically to the ASCII one.
    expect(countySlug("Prince George’s", "MD")).toBe(countySlug("Prince George's", "MD"));
  });

  it("treats a period as a separator rather than deleting it", () => {
    // Periods are deliberately NOT in the strip class: slugify already
    // collapses ". " to one "-", and deleting the period first would join the
    // words on an unspaced spelling. Re-adding "." to the class fails this.
    expect(countySlug("St.Louis", "MN")).toBe("st-louis-mn");
    expect(countySlug("St.Louis", "MN")).toBe(countySlug("St. Louis", "MN"));
  });

  it("keeps a trailing ' city' — an independent city is not the same place as the county", () => {
    expect(countySlug("St. Louis city", "MO")).not.toBe(countySlug("St. Louis", "MO"));
  });

  it("is idempotent under normalizeCounty — the suffixed and bare spellings agree", () => {
    const cases: Array<[string, string]> = [
      ["Loudoun County", "VA"],
      ["Rapides Parish", "LA"],
      ["Matanuska-Susitna Borough", "AK"],
      ["St. Louis County", "MN"],
      ["Prince George's County", "MD"],
      ["Loudoun", "VA"],
    ];
    for (const [county, state] of cases) {
      expect(countySlug(normalizeCounty(county), state)).toBe(countySlug(county, state));
    }
  });

  it("lowercases the state suffix regardless of the input casing", () => {
    expect(countySlug("Loudoun", "va")).toBe("loudoun-va");
  });

  it("separates the same county name in different states", () => {
    expect(countySlug("Washington", "OR")).not.toBe(countySlug("Washington", "UT"));
  });
});

describe("canonicalCountyName", () => {
  it("returns the only spelling when the data agrees", () => {
    expect(canonicalCountyName(["Loudoun", "Loudoun", "Loudoun"])).toBe("Loudoun");
  });

  it("returns the most frequent spelling even when it is not alphabetically first", () => {
    expect(canonicalCountyName(["Zebra", "Apple", "Zebra"])).toBe("Zebra");
  });

  it("breaks a 1-1 tie in favour of the alphabetically first spelling", () => {
    expect(canonicalCountyName(["Zebra", "Apple"])).toBe("Apple");
    expect(canonicalCountyName(["Apple", "Zebra"])).toBe("Apple");
  });

  it("breaks the live St. Louis city tie deterministically", () => {
    // The real MO case: one record each of two spellings. localeCompare puts
    // the lowercase "city" first, so that is the label both permutations pick.
    expect(canonicalCountyName(["St. Louis city", "St. Louis City"])).toBe("St. Louis city");
    expect(canonicalCountyName(["St. Louis City", "St. Louis city"])).toBe("St. Louis city");
  });

  it("is independent of input order for any permutation", () => {
    const input = ["B", "A", "B", "C", "A", "B"];
    const expected = canonicalCountyName(input);
    expect(expected).toBe("B");
    expect(canonicalCountyName([...input].reverse())).toBe(expected);
    expect(canonicalCountyName([...input].sort())).toBe(expected);
  });

  it("returns an empty string for no spellings", () => {
    expect(canonicalCountyName([])).toBe("");
  });
});

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
