import { describe, it, expect } from "vitest";

import { normalizeCountiesIn, tallyByState } from "./normalize-county-suffixes";
import type { DataCenterFacility } from "../lib/schema";

/**
 * Fixture-only by design. This suite deliberately does NOT read the live
 * data/facilities.json: the whole point of the script is that the maintainer
 * is about to change that dataset, and a test coupled to it would flip from
 * green to green-for-the-wrong-reason the moment he does.
 */
function makeFacility(
  id: string,
  state: string,
  county?: string,
): DataCenterFacility {
  const base = { lat: 40, lon: -90, state, precision: "exact" as const };
  return {
    id,
    name: `Facility ${id}`,
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: county === undefined ? base : { ...base, county },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com",
        label: "Example source",
        retrievedAt: "2026-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2026-01-01",
  };
}

describe("normalizeCountiesIn", () => {
  it("strips a ' County' suffix", () => {
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("tulsa", "OK", "Tulsa County"),
    ]);

    expect(facilities[0].location.county).toBe("Tulsa");
    expect(changes).toEqual([{ id: "tulsa", state: "OK", from: "Tulsa County", to: "Tulsa" }]);
  });

  it("strips a ' Parish' suffix", () => {
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("rapides", "LA", "Rapides Parish"),
    ]);

    expect(facilities[0].location.county).toBe("Rapides");
    expect(changes).toHaveLength(1);
    expect(changes[0].to).toBe("Rapides");
  });

  it("leaves a bare county name untouched", () => {
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("loudoun", "VA", "Loudoun"),
    ]);

    expect(facilities[0].location.county).toBe("Loudoun");
    expect(changes).toEqual([]);
  });

  it("leaves an independent city's lowercase ' city' untouched", () => {
    // "Baltimore city" is the place's actual name, not a suffixed county —
    // stripping it would merge it with a same-named county elsewhere.
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("baltimore", "MD", "Baltimore city"),
      makeFacility("stl-lower", "MO", "St. Louis city"),
      makeFacility("stl-upper", "MO", "St. Louis City"),
    ]);

    expect(facilities.map((f) => f.location.county)).toEqual([
      "Baltimore city",
      "St. Louis city",
      "St. Louis City",
    ]);
    expect(changes).toEqual([]);
  });

  it("leaves a record with no county untouched", () => {
    const { facilities, changes } = normalizeCountiesIn([makeFacility("nowhere", "TX")]);

    expect(facilities[0].location.county).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const input = [
      makeFacility("tulsa", "OK", "Tulsa County"),
      makeFacility("rapides", "LA", "Rapides Parish"),
      makeFacility("loudoun", "VA", "Loudoun"),
    ];

    const first = normalizeCountiesIn(input);
    expect(first.changes).toHaveLength(2);

    const second = normalizeCountiesIn(first.facilities);
    expect(second.changes).toEqual([]);
    expect(second.facilities).toEqual(first.facilities);
  });

  it("does not mutate its input", () => {
    const input = [makeFacility("tulsa", "OK", "Tulsa County")];
    const snapshot = structuredClone(input);

    const { facilities } = normalizeCountiesIn(input);

    expect(input).toEqual(snapshot);
    expect(input[0].location.county).toBe("Tulsa County");
    // The corrected record must be a different object, not an aliased one.
    expect(facilities[0]).not.toBe(input[0]);
  });

  it("passes unchanged records through by reference", () => {
    const input = [makeFacility("loudoun", "VA", "Loudoun")];
    const { facilities } = normalizeCountiesIn(input);

    expect(facilities[0]).toBe(input[0]);
  });

  it("returns an empty change list for an empty input", () => {
    expect(normalizeCountiesIn([])).toEqual({ facilities: [], changes: [] });
  });
});

describe("tallyByState", () => {
  it("counts per state, sorted count desc then state A→Z", () => {
    const tally = tallyByState([
      { id: "a", state: "WI", from: "Dane County", to: "Dane" },
      { id: "b", state: "OK", from: "Tulsa County", to: "Tulsa" },
      { id: "c", state: "OK", from: "Mayes County", to: "Mayes" },
      { id: "d", state: "WI", from: "Rock County", to: "Rock" },
      { id: "e", state: "OK", from: "Kay County", to: "Kay" },
      { id: "f", state: "LA", from: "Rapides Parish", to: "Rapides" },
    ]);

    expect(tally).toEqual([
      ["OK", 3],
      ["WI", 2],
      ["LA", 1],
    ]);
  });

  it("breaks a count tie alphabetically", () => {
    const tally = tallyByState([
      { id: "a", state: "WI", from: "Dane County", to: "Dane" },
      { id: "b", state: "LA", from: "Rapides Parish", to: "Rapides" },
    ]);

    expect(tally).toEqual([
      ["LA", 1],
      ["WI", 1],
    ]);
  });

  it("returns an empty tally for no changes", () => {
    expect(tallyByState([])).toEqual([]);
  });
});
