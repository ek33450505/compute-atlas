import { describe, it, expect } from "vitest";

import { dedupeRecord } from "./dedupe-source-urls";
import type { DataCenterFacility, Source } from "../lib/schema";

/**
 * Fixture-only by design, matching scripts/normalize-county-suffixes.test.ts:
 * this suite never reads data/facilities.json. The script exists precisely to
 * change that file, so a test coupled to it would go green-for-the-wrong-reason
 * the moment the migration runs.
 *
 * The assertion that carries the weight here is URL IDENTITY, not index
 * arithmetic. `checkSourceIndexBounds` already rejects an out-of-range index,
 * and dedupe only ever shifts indices DOWNWARD — always back into range — so
 * the failure this script must not have is a ref that still validates while
 * pointing at the wrong source. Every test below checks what a ref RESOLVES TO,
 * not what number it holds.
 */
function src(name: string, over: Partial<Source> = {}): Source {
  return {
    url: `https://example.com/${name}`,
    label: name,
    retrievedAt: "2026-01-01",
    kind: "other",
    ...over,
  };
}

function facility(over: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test DC",
    operator: "Op",
    facilityType: "data_center",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "approximate" },
    statusHistory: [],
    sources: [src("a")],
    lastUpdated: "2026-01-01",
    ...over,
  };
}

describe("dedupeRecord", () => {
  it("returns null for a record with no duplicates, so untouched records stay untouched", () => {
    expect(dedupeRecord(facility({ sources: [src("a"), src("b")] }))).toBeNull();
  });

  it("collapses a duplicate URL and keeps the FIRST occurrence's position", () => {
    const f = facility({ sources: [src("a"), src("b"), src("a")] });
    const res = dedupeRecord(f)!;
    expect(res.outcome.skipped).toBeUndefined();
    expect(res.next.sources.map((s) => s.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(res.outcome.removed).toBe(1);
  });

  it("keeps every sourceIndex RESOLVING to the same URL after the collapse", () => {
    // statusHistory[0] -> index 2 (the duplicate of "a"); after dedupe it must
    // resolve to "a" at index 0. An index-only assertion would miss a remap
    // that lands on "b" — still in range, still schema-valid, silently wrong.
    const f = facility({
      sources: [src("a"), src("b"), src("a"), src("c")],
      statusHistory: [
        { status: "proposed", date: "2026-01-01", sourceIndex: 2 },
        { status: "operational", date: "2026-02-01", sourceIndex: 3 },
      ],
    });
    const res = dedupeRecord(f)!;
    expect(res.outcome.skipped).toBeUndefined();
    const urls = res.next.sources.map((s) => s.url);
    expect(urls).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(urls[res.next.statusHistory[0].sourceIndex!]).toBe("https://example.com/a");
    expect(urls[res.next.statusHistory[1].sourceIndex!]).toBe("https://example.com/c");
  });

  it("remaps a REQUIRED stakeholder sourceIndex to the same URL", () => {
    // stakeholders[].sourceIndex is required by the schema, unlike the others.
    const f = facility({
      sources: [src("a"), src("b"), src("a")],
      stakeholders: [
        { name: "A Person", role: "public_official", sourceIndex: 2, asOf: "2026-01-01" },
      ],
    } as Partial<DataCenterFacility>);
    const res = dedupeRecord(f)!;
    expect(res.outcome.skipped).toBeUndefined();
    const idx = res.next.stakeholders![0].sourceIndex;
    expect(res.next.sources[idx].url).toBe("https://example.com/a");
  });

  it("takes the LATEST retrievedAt across copies", () => {
    const f = facility({
      sources: [
        src("a", { retrievedAt: "2026-03-01" }),
        src("a", { retrievedAt: "2026-07-01" }),
      ],
    });
    const res = dedupeRecord(f)!;
    expect(res.next.sources[0].retrievedAt).toBe("2026-07-01");
  });

  it("fills an absent publisher from a later copy without overwriting a present one", () => {
    const filled = dedupeRecord(
      facility({ sources: [src("a"), src("a", { publisher: "Reuters" })] })
    )!;
    expect(filled.next.sources[0].publisher).toBe("Reuters");

    const kept = dedupeRecord(
      facility({
        sources: [src("a", { publisher: "Curated" }), src("a", { publisher: "Reuters" })],
      })
    )!;
    expect(kept.next.sources[0].publisher).toBe("Curated");
  });

  it("upgrades a default 'other' kind to a specific one", () => {
    const res = dedupeRecord(
      facility({ sources: [src("a", { kind: "other" }), src("a", { kind: "permit" })] })
    )!;
    expect(res.next.sources[0].kind).toBe("permit");
  });

  it("SKIPS the record when two copies claim different specific kinds", () => {
    // The script must refuse rather than pick. Two passes disagreeing on
    // press-vs-permit is a curation question, and guessing it silently is how
    // a cleanup becomes a data change nobody reviewed.
    const res = dedupeRecord(
      facility({ sources: [src("a", { kind: "press" }), src("a", { kind: "permit" })] })
    )!;
    expect(res.outcome.skipped).toMatch(/conflicting source kinds/);
    expect(res.next.sources).toHaveLength(2); // original returned unchanged
  });

  it("keeps the first copy's label and reports the disagreement rather than resolving it", () => {
    const res = dedupeRecord(
      facility({
        sources: [src("a", { label: "First label" }), src("a", { label: "Second label" })],
      })
    )!;
    expect(res.next.sources[0].label).toBe("First label");
    expect(res.outcome.labelDisagreements).toBe(1);
  });

  it("does not mutate the input record", () => {
    const f = facility({
      sources: [src("a"), src("a", { retrievedAt: "2026-09-01" })],
      statusHistory: [{ status: "proposed", date: "2026-01-01", sourceIndex: 1 }],
    });
    const snapshot = JSON.stringify(f);
    dedupeRecord(f);
    expect(JSON.stringify(f)).toBe(snapshot);
  });
});
