import { describe, it, expect } from "vitest";
import {
  US_STATE_NAMES,
  stateNameFromCode,
  stateSlugFromCode,
  stateCodeFromSlug,
  containsDc,
  statesStat,
  statesPhrase,
} from "@/lib/us-states";
import { getStates } from "@/lib/data";

describe("us-states", () => {
  it("has exactly 51 entries (50 states + DC)", () => {
    expect(Object.keys(US_STATE_NAMES)).toHaveLength(51);
  });

  it("round-trips every code through slug and back", () => {
    for (const code of Object.keys(US_STATE_NAMES)) {
      const slug = stateSlugFromCode(code);
      expect(slug).toBeDefined();
      expect(stateCodeFromSlug(slug!)).toBe(code);
    }
  });

  it("slugifies two-word states correctly", () => {
    expect(stateSlugFromCode("NY")).toBe("new-york");
    expect(stateSlugFromCode("NC")).toBe("north-carolina");
    expect(stateSlugFromCode("WV")).toBe("west-virginia");
    expect(stateSlugFromCode("RI")).toBe("rhode-island");
  });

  it("is case-insensitive on lookup", () => {
    expect(stateNameFromCode("ny")).toBe("New York");
    expect(stateSlugFromCode("ny")).toBe("new-york");
    expect(stateCodeFromSlug("NEW-YORK")).toBe("NY");
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

describe("statesStat", () => {
  // The value assertions are the ones that actually bite: a call site that
  // reverts to passing the raw total as `value` (the exact "51 / States +
  // DC" bug) still gets the label right and only the value goes stale.
  it('derives {value: 50, label: "States + DC"} from a 51-jurisdiction total that includes DC', () => {
    expect(statesStat(51, true)).toEqual({ value: 50, label: "States + DC" });
  });

  it('singularizes the label to "State + DC" when exactly one state plus DC', () => {
    expect(statesStat(2, true)).toEqual({ value: 1, label: "State + DC" });
  });

  it('is {value: 1, label: "DC"} when DC is the only jurisdiction (total === 1)', () => {
    expect(statesStat(1, true)).toEqual({ value: 1, label: "DC" });
  });

  it("passes the total through unchanged when withDc is false", () => {
    expect(statesStat(49, false)).toEqual({ value: 49, label: "States" });
    expect(statesStat(0, false)).toEqual({ value: 0, label: "States" });
  });

  it('singularizes to "State" when withDc is false and total is exactly 1', () => {
    expect(statesStat(1, false)).toEqual({ value: 1, label: "State" });
  });
});

describe("statesPhrase", () => {
  it("pluralizes states and appends DC when withDc is true and total > 1", () => {
    expect(statesPhrase(51, true)).toBe("50 states and DC");
  });

  it("singularizes the state count when withDc is true and exactly one state plus DC", () => {
    expect(statesPhrase(2, true)).toBe("1 state and DC");
  });

  it('is "DC" alone when withDc is true and DC is the only jurisdiction', () => {
    expect(statesPhrase(1, true)).toBe("DC");
  });

  it("omits DC entirely when withDc is false", () => {
    expect(statesPhrase(49, false)).toBe("49 states");
  });

  it("singularizes when withDc is false and total is 1", () => {
    expect(statesPhrase(1, false)).toBe("1 state");
  });

  it("handles zero when withDc is false", () => {
    expect(statesPhrase(0, false)).toBe("0 states");
  });
});
