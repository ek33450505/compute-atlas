import { describe, it, expect } from "vitest";
import {
  US_STATE_NAMES,
  US_TERRITORY_NAMES,
  stateNameFromCode,
  stateSlugFromCode,
  stateCodeFromSlug,
  containsDc,
  isStateCode,
  isTerritoryCode,
  splitJurisdictions,
  statesStat,
  statesPhrase,
} from "@/lib/us-states";
import { getStates } from "@/lib/data";

describe("us-states", () => {
  it("has exactly 51 entries (50 states + DC)", () => {
    expect(Object.keys(US_STATE_NAMES)).toHaveLength(51);
  });

  it("has exactly 5 territory entries", () => {
    expect(Object.keys(US_TERRITORY_NAMES).sort()).toEqual(["AS", "GU", "MP", "PR", "VI"]);
  });

  it("round-trips every state/DC code through slug and back", () => {
    for (const code of Object.keys(US_STATE_NAMES)) {
      const slug = stateSlugFromCode(code);
      expect(slug).toBeDefined();
      expect(stateCodeFromSlug(slug!)).toBe(code);
    }
  });

  it("round-trips every territory code through name, slug, and back", () => {
    for (const code of Object.keys(US_TERRITORY_NAMES)) {
      const name = stateNameFromCode(code);
      expect(name).toBeDefined();
      const slug = stateSlugFromCode(code);
      expect(slug).toBeDefined();
      expect(stateCodeFromSlug(slug!)).toBe(code);
    }
  });

  it("resolves each territory code to its full name", () => {
    expect(stateNameFromCode("PR")).toBe("Puerto Rico");
    expect(stateNameFromCode("GU")).toBe("Guam");
    expect(stateNameFromCode("VI")).toBe("U.S. Virgin Islands");
    expect(stateNameFromCode("MP")).toBe("Northern Mariana Islands");
    expect(stateNameFromCode("AS")).toBe("American Samoa");
  });

  it("slugifies two-word states correctly", () => {
    expect(stateSlugFromCode("NY")).toBe("new-york");
    expect(stateSlugFromCode("NC")).toBe("north-carolina");
    expect(stateSlugFromCode("WV")).toBe("west-virginia");
    expect(stateSlugFromCode("RI")).toBe("rhode-island");
  });

  it("slugifies territory names correctly", () => {
    expect(stateSlugFromCode("PR")).toBe("puerto-rico");
    expect(stateSlugFromCode("MP")).toBe("northern-mariana-islands");
  });

  it('strips punctuation from "U.S. Virgin Islands" rather than leaving it in the URL', () => {
    expect(stateSlugFromCode("VI")).toBe("us-virgin-islands");
  });

  it('round-trips the punctuation-stripped VI slug back to "VI"', () => {
    expect(stateCodeFromSlug("us-virgin-islands")).toBe("VI");
  });

  it("still displays the formal name with punctuation intact — only the slug changed", () => {
    expect(US_TERRITORY_NAMES.VI).toBe("U.S. Virgin Islands");
    expect(stateNameFromCode("VI")).toBe("U.S. Virgin Islands");
  });

  it("pins every state and DC slug to its exact current value (none contain punctuation, so none should have changed)", () => {
    const expectedSlugs: Record<string, string> = {
      AL: "alabama",
      AK: "alaska",
      AZ: "arizona",
      AR: "arkansas",
      CA: "california",
      CO: "colorado",
      CT: "connecticut",
      DC: "district-of-columbia",
      DE: "delaware",
      FL: "florida",
      GA: "georgia",
      HI: "hawaii",
      ID: "idaho",
      IL: "illinois",
      IN: "indiana",
      IA: "iowa",
      KS: "kansas",
      KY: "kentucky",
      LA: "louisiana",
      ME: "maine",
      MD: "maryland",
      MA: "massachusetts",
      MI: "michigan",
      MN: "minnesota",
      MS: "mississippi",
      MO: "missouri",
      MT: "montana",
      NE: "nebraska",
      NV: "nevada",
      NH: "new-hampshire",
      NJ: "new-jersey",
      NM: "new-mexico",
      NY: "new-york",
      NC: "north-carolina",
      ND: "north-dakota",
      OH: "ohio",
      OK: "oklahoma",
      OR: "oregon",
      PA: "pennsylvania",
      RI: "rhode-island",
      SC: "south-carolina",
      SD: "south-dakota",
      TN: "tennessee",
      TX: "texas",
      UT: "utah",
      VT: "vermont",
      VA: "virginia",
      WA: "washington",
      WV: "west-virginia",
      WI: "wisconsin",
      WY: "wyoming",
    };
    const actualSlugs = Object.fromEntries(Object.keys(US_STATE_NAMES).map((code) => [code, stateSlugFromCode(code)]));
    expect(actualSlugs).toEqual(expectedSlugs);
  });

  it("is case-insensitive on lookup", () => {
    expect(stateNameFromCode("ny")).toBe("New York");
    expect(stateSlugFromCode("ny")).toBe("new-york");
    expect(stateCodeFromSlug("NEW-YORK")).toBe("NY");
  });

  it("is case-insensitive on territory lookup", () => {
    expect(stateNameFromCode("pr")).toBe("Puerto Rico");
    expect(stateCodeFromSlug("PUERTO-RICO")).toBe("PR");
  });

  it("returns undefined for unknown codes/slugs", () => {
    expect(stateNameFromCode("ZZ")).toBeUndefined();
    expect(stateSlugFromCode("ZZ")).toBeUndefined();
    expect(stateCodeFromSlug("atlantis")).toBeUndefined();
  });

  it("resolves every state code present in the dataset to a name", async () => {
    expect((await getStates()).every((c) => stateNameFromCode(c) !== undefined)).toBe(true);
  });
});

describe("containsDc", () => {
  it("is true when the set includes DC", () => {
    expect(containsDc(["NY", "DC", "CA"])).toBe(true);
  });

  it("is false when the set does not include DC", () => {
    expect(containsDc(["NY", "CA", "TX"])).toBe(false);
  });

  it("is false for an empty iterable", () => {
    expect(containsDc([])).toBe(false);
  });
});

describe("isStateCode", () => {
  it("is true for a real state code", () => {
    expect(isStateCode("CA")).toBe(true);
  });

  it("is false for DC — DC is a jurisdiction, not one of the 50 states", () => {
    expect(isStateCode("DC")).toBe(false);
  });

  it("is false for a territory code", () => {
    expect(isStateCode("PR")).toBe(false);
  });

  it("is false for an unknown code", () => {
    expect(isStateCode("ZZ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isStateCode("ca")).toBe(true);
  });
});

describe("isTerritoryCode", () => {
  it("is true for each of the five territory codes", () => {
    for (const code of ["AS", "GU", "MP", "PR", "VI"]) {
      expect(isTerritoryCode(code)).toBe(true);
    }
  });

  it("is false for a state code", () => {
    expect(isTerritoryCode("CA")).toBe(false);
  });

  it("is false for DC", () => {
    expect(isTerritoryCode("DC")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isTerritoryCode("pr")).toBe(true);
  });
});

describe("splitJurisdictions", () => {
  it("separates states from DC and territories", () => {
    expect(splitJurisdictions(["CA", "DC", "PR", "TX"])).toEqual({
      states: ["CA", "TX"],
      other: ["DC", "PR"],
    });
  });

  it("sorts both arrays", () => {
    expect(splitJurisdictions(["TX", "CA", "NY"])).toEqual({
      states: ["CA", "NY", "TX"],
      other: [],
    });
  });

  it("de-duplicates repeated codes", () => {
    expect(splitJurisdictions(["CA", "CA", "DC", "DC"])).toEqual({
      states: ["CA"],
      other: ["DC"],
    });
  });

  it("ignores unknown codes rather than throwing", () => {
    expect(splitJurisdictions(["CA", "ZZ", "??"])).toEqual({
      states: ["CA"],
      other: [],
    });
  });

  it("normalizes case", () => {
    expect(splitJurisdictions(["ca", "dc"])).toEqual({
      states: ["CA"],
      other: ["DC"],
    });
  });

  it("returns two empty arrays for an empty input", () => {
    expect(splitJurisdictions([])).toEqual({ states: [], other: [] });
  });
});

describe("statesStat", () => {
  // The value assertions are the ones that actually bite: a call site that
  // reverts to passing a raw total (the exact "51 / States + DC" bug) still
  // gets the label right and only the value goes stale. Every expectation
  // below is a typed-out literal, never the constant under test, so a
  // regression in the implementation can't also regress the assertion.
  //
  // The label no longer names DC or territories at all — that moved into
  // `note`, printed as a footnote under the row (Ed, QA, 2026-09-14). So the
  // note assertions carry what the label assertions used to: they are the
  // only thing standing between a bare "50 / States" caption and a reader who
  // concludes the atlas has never heard of Puerto Rico.

  it('is {value: 1, label: "State"} for a single state', () => {
    expect(statesStat(["CA"])).toEqual({ value: 1, label: "State" });
  });

  it('is {value: N, label: "States"} for multiple states, no DC or territories', () => {
    expect(statesStat(["CA", "TX", "NY"])).toEqual({ value: 3, label: "States" });
  });

  it("leaves the label bare and adds no note when the set is states only", () => {
    // The note key must be ABSENT, not an empty string: a render primitive
    // decides whether to print a footnote marker by truthiness of `note`, and
    // `""` would put a marker over a tile with nothing to explain.
    expect(statesStat(["CA", "TX"])).not.toHaveProperty("note");
  });

  it('keeps the label singular and footnotes DC for one state plus DC', () => {
    expect(statesStat(["CA", "DC"])).toEqual({
      value: 1,
      label: "State",
      note: "Plus the District of Columbia",
    });
  });

  it('derives {value: 50, label: "States"} from all 50 states plus DC — the caption never says "+ DC"', () => {
    const allStatesPlusDc = [...Object.keys(US_STATE_NAMES).filter((c) => c !== "DC"), "DC"];
    expect(statesStat(allStatesPlusDc)).toEqual({
      value: 50,
      label: "States",
      note: "Plus the District of Columbia",
    });
  });

  it("singularizes the territory count in the note for one state plus one territory", () => {
    expect(statesStat(["CA", "PR"])).toEqual({
      value: 1,
      label: "State",
      note: "Plus 1 U.S. territory",
    });
  });

  it("counts the territories in the note for multiple states plus territories, no DC", () => {
    expect(statesStat(["CA", "TX", "PR", "GU"])).toEqual({
      value: 2,
      label: "States",
      note: "Plus 2 U.S. territories",
    });
  });

  it("names DC and counts the territory for one state, DC, and a territory", () => {
    expect(statesStat(["CA", "DC", "PR"])).toEqual({
      value: 1,
      label: "State",
      note: "Plus the District of Columbia and 1 U.S. territory",
    });
  });

  it("names DC and counts the territories for multiple states, DC, and territories", () => {
    expect(statesStat(["CA", "TX", "DC", "PR", "GU"])).toEqual({
      value: 2,
      label: "States",
      note: "Plus the District of Columbia and 2 U.S. territories",
    });
  });

  it("keeps the label one word as territories accumulate — only the note grows", () => {
    // The whole point of moving the qualifier into a footnote: the caption is
    // stacked under a 4xl figure in wide-tracked uppercase mono, so it cannot
    // absorb another term. Adding every territory the dataset could ever hold
    // must not lengthen it by a character.
    const everything = [
      ...Object.keys(US_STATE_NAMES).filter((c) => c !== "DC"),
      "DC",
      "PR",
      "GU",
      "VI",
      "MP",
      "AS",
    ];
    expect(statesStat(everything)).toEqual({
      value: 50,
      label: "States",
      note: "Plus the District of Columbia and 5 U.S. territories",
    });
  });

  it("never lists territories by name in the note — that is what /states is for", () => {
    const { note } = statesStat(["CA", "PR", "GU", "VI"]);
    expect(note).toBe("Plus 3 U.S. territories");
    for (const name of ["Puerto Rico", "Guam", "Virgin Islands"]) {
      expect(note).not.toContain(name);
    }
  });

  it('is {value: 1, label: "DC"} when DC is the only jurisdiction present', () => {
    expect(statesStat(["DC"])).toEqual({ value: 1, label: "DC" });
  });

  it("names the territory itself when exactly one territory is present with no states", () => {
    expect(statesStat(["PR"])).toEqual({ value: 1, label: "Puerto Rico" });
    expect(statesStat(["GU"])).toEqual({ value: 1, label: "Guam" });
  });

  it('is "Jurisdictions" for several non-state jurisdictions with no states (DC + territory)', () => {
    expect(statesStat(["DC", "PR"])).toEqual({ value: 2, label: "Jurisdictions" });
  });

  it('is "Jurisdictions" for several territories with no states and no DC', () => {
    expect(statesStat(["PR", "GU"])).toEqual({ value: 2, label: "Jurisdictions" });
  });

  it('is {value: 0, label: "States"} for an empty set', () => {
    expect(statesStat([])).toEqual({ value: 0, label: "States" });
  });

  it("ignores unknown codes rather than counting or crashing on them", () => {
    expect(statesStat(["CA", "ZZ"])).toEqual({ value: 1, label: "State" });
  });

  it("adds no note to the zero-state labels, whose caption already names the whole set", () => {
    // "DC" / "Puerto Rico" / "Jurisdictions" describe every code present, so a
    // footnote there would repeat the caption rather than extend it.
    for (const codes of [["DC"], ["PR"], ["DC", "PR"], ["PR", "GU"], []]) {
      expect(statesStat(codes)).not.toHaveProperty("note");
    }
  });
});

describe("statesPhrase", () => {
  // Same discipline as `statesStat`: every expectation is a typed-out
  // literal, never the constant under test.

  it('is "1 state" for a single state', () => {
    expect(statesPhrase(["CA"])).toBe("1 state");
  });

  it('is "N states" for multiple states, no DC or territories', () => {
    expect(statesPhrase(["CA", "TX", "NY"])).toBe("3 states");
  });

  it('singularizes to "1 state and DC" for one state plus DC — byte-identical to the prior wording', () => {
    expect(statesPhrase(["CA", "DC"])).toBe("1 state and DC");
  });

  it('is "50 states and DC" for all 50 states plus DC — byte-identical to the shipped wording', () => {
    const allStatesPlusDc = [...Object.keys(US_STATE_NAMES).filter((c) => c !== "DC"), "DC"];
    expect(statesPhrase(allStatesPlusDc)).toBe("50 states and DC");
  });

  it('singularizes the territory count to "1 state and 1 territory"', () => {
    expect(statesPhrase(["CA", "PR"])).toBe("1 state and 1 territory");
  });

  it('pluralizes the territory count to "N states and 2 territories"', () => {
    expect(statesPhrase(["CA", "TX", "PR", "GU"])).toBe("2 states and 2 territories");
  });

  it('joins state, DC and one territory as "1 state, DC and 1 territory"', () => {
    expect(statesPhrase(["CA", "DC", "PR"])).toBe("1 state, DC and 1 territory");
  });

  it('joins states, DC and territories as "N states, DC and 2 territories"', () => {
    expect(statesPhrase(["CA", "TX", "DC", "PR", "GU"])).toBe("2 states, DC and 2 territories");
  });

  it('is "DC" alone when DC is the only jurisdiction present', () => {
    expect(statesPhrase(["DC"])).toBe("DC");
  });

  it("names the territory itself when exactly one territory is present with no states — pins the non-`!` fallback branch", () => {
    expect(statesPhrase(["PR"])).toBe("Puerto Rico");
    expect(statesPhrase(["GU"])).toBe("Guam");
  });

  it('is "N jurisdictions" for several non-state jurisdictions with no states (DC + territory)', () => {
    expect(statesPhrase(["DC", "PR"])).toBe("2 jurisdictions");
  });

  it('is "N jurisdictions" for several territories with no states and no DC', () => {
    expect(statesPhrase(["PR", "GU"])).toBe("2 jurisdictions");
  });

  it('is "0 states" for an empty set', () => {
    expect(statesPhrase([])).toBe("0 states");
  });

  it("ignores unknown codes rather than counting or crashing on them", () => {
    expect(statesPhrase(["CA", "ZZ"])).toBe("1 state");
  });
});
