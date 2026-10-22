import { describe, it, expect } from "vitest";
import type { Facility } from "./schema";
import { isEditorialOnlyChange } from "./editorial-change";

function doc(over: Record<string, unknown> = {}): Facility {
  return {
    id: "f1",
    name: "F",
    operator: "Op",
    facilityType: "data_center",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 1, lon: 2, state: "GA", precision: "exact" },
    statusHistory: [{ status: "planned", date: "2025-01-01", note: "a" }],
    sources: [],
    lastUpdated: "2025-06-01",
    capacityMw: { operational: 10 },
    energy: { source: "grid", notes: "n" },
    notes: "top",
    ...over,
  } as unknown as Facility;
}

describe("isEditorialOnlyChange", () => {
  it("true for top-level notes only", () => {
    expect(isEditorialOnlyChange(doc(), doc({ notes: "rewritten" }))).toBe(true);
  });
  it("true for nested energy.notes only", () => {
    expect(isEditorialOnlyChange(doc(), doc({ energy: { source: "grid", notes: "x" } }))).toBe(true);
  });
  it("true for statusHistory[0].note only", () => {
    expect(
      isEditorialOnlyChange(
        doc(),
        doc({ statusHistory: [{ status: "planned", date: "2025-01-01", note: "b" }] })
      )
    ).toBe(true);
  });
  it("true when notes are removed entirely", () => {
    const { notes: _drop, ...rest } = doc() as unknown as Record<string, unknown>;
    void _drop;
    expect(isEditorialOnlyChange(doc(), rest as unknown as Facility)).toBe(true);
  });
  it("false for notes + lastUpdated", () => {
    expect(isEditorialOnlyChange(doc(), doc({ notes: "x", lastUpdated: "2026-01-01" }))).toBe(false);
  });
  it("false for notes + a number", () => {
    expect(isEditorialOnlyChange(doc(), doc({ notes: "x", capacityMw: { operational: 11 } }))).toBe(
      false
    );
  });
  it("false for identical docs", () => {
    expect(isEditorialOnlyChange(doc(), doc())).toBe(false);
  });
  it("does not ignore a non-notes key such as notesUrl", () => {
    expect(isEditorialOnlyChange(doc({ notesUrl: "a" }), doc({ notesUrl: "b" }))).toBe(false);
  });
  it("false when a non-string notes value changes", () => {
    expect(
      isEditorialOnlyChange(doc({ notes: { a: 1 } }), doc({ notes: { a: 2 } }))
    ).toBe(false);
  });
  it("false when notes changes from a string to an object", () => {
    expect(isEditorialOnlyChange(doc({ notes: "text" }), doc({ notes: { a: 1 } }))).toBe(false);
  });
  it("is order-sensitive for arrays", () => {
    const a = doc({ sources: [{ url: "1" }, { url: "2" }] });
    const b = doc({ sources: [{ url: "2" }, { url: "1" }], notes: "x" });
    expect(isEditorialOnlyChange(a, b)).toBe(false);
  });
});
