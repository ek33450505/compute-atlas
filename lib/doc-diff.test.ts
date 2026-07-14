import { describe, it, expect } from "vitest";
import { computeDocDiff } from "@/lib/doc-diff";

describe("computeDocDiff", () => {
  it("treats before=null as a create — every after key appears as {before:null, after:value}", () => {
    const after = { name: "Test Facility", status: "operational", capacityMw: 100 };
    const result = computeDocDiff(null, after);

    expect(result).toHaveLength(3);
    expect(result).toEqual(
      expect.arrayContaining([
        { key: "name", before: null, after: "Test Facility" },
        { key: "status", before: null, after: "operational" },
        { key: "capacityMw", before: null, after: 100 },
      ])
    );
  });

  it("treats after=null as a delete — every before key appears as {before:value, after:null}", () => {
    const before = { name: "Test Facility", status: "operational" };
    const result = computeDocDiff(before, null);

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { key: "name", before: "Test Facility", after: null },
        { key: "status", before: "operational", after: null },
      ])
    );
  });

  it("returns an empty array when there are no changes", () => {
    const doc = { name: "Test Facility", status: "operational", capacityMw: 100 };
    const result = computeDocDiff(doc, { ...doc });

    expect(result).toEqual([]);
  });

  it("returns only the keys that actually changed", () => {
    const before = { name: "Test Facility", status: "operational", capacityMw: 100 };
    const after = { name: "Test Facility", status: "under_construction", capacityMw: 100 };
    const result = computeDocDiff(before, after);

    expect(result).toEqual([{ key: "status", before: "operational", after: "under_construction" }]);
  });

  it("reproduces submission-detail.tsx's UpdateDiff behavior: computeDocDiff(current, {...current, ...patch}) flags only patch's own changed keys", () => {
    const current = { name: "Test Facility", status: "operational", capacityMw: 100, operator: "Acme" };
    const patch = { status: "under_construction", capacityMw: 150 };
    const merged = { ...current, ...patch };

    const result = computeDocDiff(current, merged);

    // Mirrors submission-detail.tsx's inline changedKeys computation: only
    // keys present in patch whose value actually differs from current.
    const expectedChangedKeys = Object.keys(patch).filter(
      (key) => JSON.stringify((current as Record<string, unknown>)[key]) !== JSON.stringify((patch as Record<string, unknown>)[key])
    );

    expect(result.map((e) => e.key).sort()).toEqual(expectedChangedKeys.sort());
    expect(result).toEqual(
      expect.arrayContaining([
        { key: "status", before: "operational", after: "under_construction" },
        { key: "capacityMw", before: 100, after: 150 },
      ])
    );
  });

  it("treats missing/undefined values as null on both sides (no dropped keys on jsonb round-trip)", () => {
    const before = { name: "Test Facility", announcedDate: undefined };
    const after = { name: "Test Facility", announcedDate: "2026-01-01" };
    const result = computeDocDiff(before, after);

    expect(result).toEqual([{ key: "announcedDate", before: null, after: "2026-01-01" }]);
  });

  it("handles both sides null (double-empty) with no entries", () => {
    expect(computeDocDiff(null, null)).toEqual([]);
  });
});
