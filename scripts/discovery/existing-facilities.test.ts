/**
 * Tests for projectExisting() — the compact per-state facility projection
 * injected into the discovery prompt as {{EXISTING_FACILITIES}}.
 */
import { describe, expect, it } from "vitest";

import type { Facility } from "../../lib/schema";
import { projectExisting } from "./existing-facilities";

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "acme-dc-1",
    name: "Acme Data Center 1",
    operator: "Acme Corp",
    status: "proposed",
    confidence: "reported",
    facilityType: "data_center",
    location: {
      lat: 30.2672,
      lon: -97.7431,
      state: "TX",
      precision: "exact",
    },
    statusHistory: [{ status: "proposed", date: "2026-01-01" }],
    sources: [
      {
        url: "https://example.com/acme-announcement",
        label: "Announcement",
        retrievedAt: "2026-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

describe("projectExisting", () => {
  it("filters facilities by location.state", () => {
    const tx = makeFacility({ id: "tx-one" });
    const va = makeFacility({
      id: "va-one",
      location: { lat: 38.9, lon: -77.4, state: "VA", precision: "exact" },
    });
    const result = projectExisting([tx, va], "TX");
    expect(result).toContain("tx-one");
    expect(result).not.toContain("va-one");
  });

  it("renders one compact pipe-delimited line per facility", () => {
    const facility = makeFacility();
    const result = projectExisting([facility], "TX");
    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "acme-dc-1 | Acme Data Center 1 | Acme Corp | proposed | 2026-01-01 | https://example.com/acme-announcement"
    );
  });

  it("uses the latest statusHistory date, not the first", () => {
    const facility = makeFacility({
      statusHistory: [
        { status: "proposed", date: "2026-01-01" },
        { status: "under_construction", date: "2026-03-15" },
      ],
    });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("2026-03-15");
    expect(result).not.toContain("2026-01-01");
  });

  it("falls back to lastUpdated when statusHistory is empty", () => {
    const facility = makeFacility({ statusHistory: [], lastUpdated: "2026-05-20" });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("2026-05-20");
  });

  it("falls back to lastUpdated when statusHistory is undefined", () => {
    const facility = makeFacility({ statusHistory: undefined, lastUpdated: "2026-06-11" });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("2026-06-11");
  });

  it("uses the first source URL when multiple sources are present", () => {
    const facility = makeFacility({
      sources: [
        {
          url: "https://example.com/first",
          label: "First",
          retrievedAt: "2026-01-01",
          kind: "press",
        },
        {
          url: "https://example.com/second",
          label: "Second",
          retrievedAt: "2026-02-01",
          kind: "press",
        },
      ],
    });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("https://example.com/first");
    expect(result).not.toContain("https://example.com/second");
  });

  it("returns an empty string for a state with zero facilities", () => {
    const facility = makeFacility();
    const result = projectExisting([facility], "OH");
    expect(result).toBe("");
  });

  it("returns an empty string for an empty facilities array", () => {
    const result = projectExisting([], "TX");
    expect(result).toBe("");
  });

  it("renders one line per facility, newline-separated, for multiple matches", () => {
    const a = makeFacility({ id: "tx-a", name: "A" });
    const b = makeFacility({ id: "tx-b", name: "B" });
    const result = projectExisting([a, b], "TX");
    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tx-a");
    expect(lines[1]).toContain("tx-b");
  });
});
