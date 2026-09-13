import { describe, it, expect } from "vitest";

import {
  normalizeCountiesIn,
  normalizeCountyCase,
  tallyByState,
} from "./normalize-county-suffixes";
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
    expect(changes).toEqual([
      { id: "tulsa", state: "OK", from: "Tulsa County", to: "Tulsa", kind: "suffix" },
    ]);
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

  it("leaves an already-canonical independent city's ' city' untouched, and does not strip it as a suffix", () => {
    // "Baltimore city" and "St. Louis city" are the places' actual names, not
    // suffixed counties — the suffix rule must never treat "city" as a
    // civil-division suffix to strip, the way it treats "County"/"Parish"/
    // "Borough". This is rule 1's job, not rule 2's; see the next test for
    // rule 2's mis-cased "St. Louis City".
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("baltimore", "MD", "Baltimore city"),
      makeFacility("stl-lower", "MO", "St. Louis city"),
    ]);

    expect(facilities.map((f) => f.location.county)).toEqual(["Baltimore city", "St. Louis city"]);
    expect(changes).toEqual([]);
  });

  it("case rule: corrects a mis-cased independent-city name to its canonical lowercase 'city'", () => {
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("stl-upper", "MO", "St. Louis City"),
    ]);

    expect(facilities[0].location.county).toBe("St. Louis city");
    expect(changes).toEqual([
      { id: "stl-upper", state: "MO", from: "St. Louis City", to: "St. Louis city", kind: "case" },
    ]);
  });

  it("case rule: does not touch an unrelated county whose real name happens to end in 'City'", () => {
    // Adversarial fixture, not a vacuous one: Virginia's real James City
    // County, once the suffix rule strips " County", becomes "James City" —
    // capitalized correctly, because that IS the county's proper name, not a
    // case bug. A blanket "lowercase any trailing city word" rule would
    // silently corrupt this; the allowlist must not.
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("james-city", "VA", "James City County"),
    ]);

    expect(facilities[0].location.county).toBe("James City");
    expect(changes).toEqual([
      {
        id: "james-city",
        state: "VA",
        from: "James City County",
        to: "James City",
        kind: "suffix",
      },
    ]);
  });

  it("case rule: is scoped per-state — a same-named 'city' string in an unlisted state is untouched", () => {
    expect(normalizeCountyCase("St. Louis City", "IL")).toBe("St. Louis City");
  });

  it("composes without double-transforming a record that matches both rules", () => {
    // Synthetic/hypothetical — no real record has a spurious " County" tacked
    // onto an independent-city name — but it is the shape both rules must
    // handle correctly in sequence: strip the suffix first, THEN fix the
    // resulting name's case, recording one change per rule rather than
    // conflating them or looping.
    const { facilities, changes } = normalizeCountiesIn([
      makeFacility("stl-both", "MO", "St. Louis City County"),
    ]);

    expect(facilities[0].location.county).toBe("St. Louis city");
    expect(changes).toEqual([
      {
        id: "stl-both",
        state: "MO",
        from: "St. Louis City County",
        to: "St. Louis City",
        kind: "suffix",
      },
      { id: "stl-both", state: "MO", from: "St. Louis City", to: "St. Louis city", kind: "case" },
    ]);

    // Re-running against the corrected output is a no-op — idempotent.
    const second = normalizeCountiesIn(facilities);
    expect(second.changes).toEqual([]);
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
      { id: "a", state: "WI", from: "Dane County", to: "Dane", kind: "suffix" },
      { id: "b", state: "OK", from: "Tulsa County", to: "Tulsa", kind: "suffix" },
      { id: "c", state: "OK", from: "Mayes County", to: "Mayes", kind: "suffix" },
      { id: "d", state: "WI", from: "Rock County", to: "Rock", kind: "suffix" },
      { id: "e", state: "OK", from: "Kay County", to: "Kay", kind: "suffix" },
      { id: "f", state: "LA", from: "Rapides Parish", to: "Rapides", kind: "suffix" },
    ]);

    expect(tally).toEqual([
      ["OK", 3],
      ["WI", 2],
      ["LA", 1],
    ]);
  });

  it("breaks a count tie alphabetically", () => {
    const tally = tallyByState([
      { id: "a", state: "WI", from: "Dane County", to: "Dane", kind: "suffix" },
      { id: "b", state: "LA", from: "Rapides Parish", to: "Rapides", kind: "suffix" },
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
