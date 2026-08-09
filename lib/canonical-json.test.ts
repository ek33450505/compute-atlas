import { describe, it, expect } from "vitest";

import { canonicalize, canonicalStringify, changedTopLevelKeys } from "@/lib/canonical-json";

describe("canonicalStringify", () => {
  it("treats key order as insignificant — jsonb round-tripping must not read as drift", () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  it("sorts keys at every depth, not just the top level", () => {
    const a = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const b = { outer: { a: { b: 3, y: 2 }, z: 1 } };

    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("keeps ARRAY order significant — sources/statusHistory are meaningfully ordered", () => {
    expect(canonicalStringify({ sources: ["a", "b"] })).not.toBe(
      canonicalStringify({ sources: ["b", "a"] })
    );
  });

  it("sorts keys inside array elements", () => {
    expect(canonicalStringify([{ b: 1, a: 2 }])).toBe(canonicalStringify([{ a: 2, b: 1 }]));
  });

  it("still reports genuine value differences", () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 2 }));
  });

  it("distinguishes a missing key from an explicit null", () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 1, b: null }));
  });

  it("passes primitives and null through untouched", () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(3)).toBe(3);
    expect(canonicalize("s")).toBe("s");
    expect(canonicalize(true)).toBe(true);
  });
});

describe("changedTopLevelKeys", () => {
  it("returns nothing when the docs differ only by key order", () => {
    expect(changedTopLevelKeys({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 })).toEqual([]);
  });

  it("reports the shallow key containing a nested change", () => {
    const before = { name: "A", location: { state: "GA", city: "Atlanta" } };
    const after = { name: "A", location: { state: "GA", city: "Macon" } };

    expect(changedTopLevelKeys(before, after)).toEqual(["location"]);
  });

  it("reports added and removed keys as well as edited ones, sorted", () => {
    const before = { name: "A", removed: 1, edited: 1 };
    const after = { name: "A", added: 1, edited: 2 };

    expect(changedTopLevelKeys(before, after)).toEqual(["added", "edited", "removed"]);
  });
});
