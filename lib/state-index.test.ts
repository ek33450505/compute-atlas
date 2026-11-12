import { describe, it, expect } from "vitest";

import { parseStateParam, stateCounts } from "./state-index";
import { stateNameFromCode } from "./us-states";

const AVAILABLE = new Set(["VA", "TX"]);

describe("parseStateParam", () => {
  it("accepts a lowercase or uppercase code that holds rows", () => {
    expect(parseStateParam("va", AVAILABLE)).toBe("VA");
    expect(parseStateParam(" TX ", AVAILABLE)).toBe("TX");
  });

  it.each([undefined, ["va", "tx"], "", "zz", "ca", "%00", "../x", "virginia", "ıa", "ſc", "v", "vaa"])(
    "returns null for %j",
    (raw) => {
      expect(parseStateParam(raw, AVAILABLE)).toBeNull();
    }
  );
});

describe("stateCounts", () => {
  it("counts rows per state and sorts by state name", () => {
    expect(stateCounts(["VA", "TX", "VA", "AL"])).toEqual([
      ["AL", 1],
      ["TX", 1],
      ["VA", 2],
    ]);
  });
});

describe("stateCounts (invalid codes)", () => {
  it("drops codes parseStateParam would refuse, so no nav link lands on the default view", () => {
    expect(stateCounts(["va", "XX", "VA", "V", ""])).toEqual([["VA", 1]]);
  });
});

describe("state sub-views cover every row", () => {
  // DC and a territory are jurisdictions outside the 50 states; both must be reachable.
  const rows = ["VA", "VA", "DC", "PR", "TX", "AL"];

  it("every nav link resolves to its own sub-view and the sub-views partition the rows", () => {
    const available = new Set(rows);
    const nav = stateCounts(rows);
    let covered = 0;
    for (const [code, count] of nav) {
      expect(parseStateParam(code.toLowerCase(), available), code).toBe(code);
      expect(stateNameFromCode(code)).toBeDefined();
      expect(rows.filter((r) => r === code)).toHaveLength(count);
      covered += count;
    }
    expect(covered).toBe(rows.length);
  });
});
