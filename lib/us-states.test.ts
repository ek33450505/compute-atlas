import { describe, it, expect } from "vitest";
import {
  US_STATE_NAMES,
  stateNameFromCode,
  stateSlugFromCode,
  stateCodeFromSlug,
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
