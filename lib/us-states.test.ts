import { describe, it, expect } from "vitest";
import {
  US_STATE_NAMES,
  stateNameFromCode,
  stateSlugFromCode,
  stateCodeFromSlug,
  containsDc,
  statesStatLabel,
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

describe("statesStatLabel", () => {
  it('is "States + DC" when withDc is true and total is more than 1', () => {
    expect(statesStatLabel(51, true)).toBe("States + DC");
  });

  it('is "DC" alone when withDc is true and DC is the only jurisdiction (total === 1)', () => {
    expect(statesStatLabel(1, true)).toBe("DC");
  });

  it('is "States" (plural) when withDc is false and total is not 1', () => {
    expect(statesStatLabel(50, false)).toBe("States");
    expect(statesStatLabel(0, false)).toBe("States");
  });

  it('is "State" (singular) when withDc is false and total is exactly 1', () => {
    expect(statesStatLabel(1, false)).toBe("State");
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
