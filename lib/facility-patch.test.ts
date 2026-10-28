import { describe, it, expect } from "vitest";
import { isPlainObject, mergeFacilityPatch } from "@/lib/facility-patch";

const existing = {
  id: "site",
  name: "Old Name",
  location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact", city: "Atlanta", county: "Fulton" },
  sources: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
};

describe("mergeFacilityPatch — location patches that restate no coordinate or state", () => {
  it("merges a city-only patch over the existing location, keeping lat, lon and an exact precision", () => {
    const merged = mergeFacilityPatch(existing, { location: { city: "New" } });
    expect(merged.location).toEqual({ ...existing.location, city: "New" });
  });

  it("merges a precision-only patch, keeping the coordinates and the old city", () => {
    const merged = mergeFacilityPatch(existing, { location: { precision: "approximate" } });
    expect(merged.location).toEqual({ ...existing.location, precision: "approximate" });
  });

  it.each(["county", "street", "postalCode"])("merges a %s-only patch", (key) => {
    const merged = mergeFacilityPatch(existing, { location: { [key]: "x" } });
    expect(merged.location).toEqual({ ...existing.location, [key]: "x" });
  });

  it("treats an explicit undefined value as absent, so precision: undefined cannot unset the stored pin", () => {
    const merged = mergeFacilityPatch(existing, { location: { precision: undefined, city: "New" } });
    expect(merged.location).toEqual({ ...existing.location, city: "New" });
  });

  it("treats undefined lat, lon and state as not restated", () => {
    const merged = mergeFacilityPatch(existing, {
      location: { lat: undefined, lon: undefined, state: undefined, city: "New" },
    });
    expect(merged.location).toEqual({ ...existing.location, city: "New" });
  });

  it("merges an empty location patch as a no-op", () => {
    expect(mergeFacilityPatch(existing, { location: {} }).location).toEqual(existing.location);
  });
});

describe("mergeFacilityPatch — a location patch that restates lat, lon or state replaces the location", () => {
  it("stores a restated pin as the patch alone, so precision is left to the schema default and the old city and county are gone", () => {
    const pin = { lat: 35, lon: -80, state: "NC" };
    const merged = mergeFacilityPatch(existing, { location: pin });
    // No precision key: facilitySchema then defaults it to "approximate"; "exact" is never produced by omission.
    expect(merged.location).toEqual(pin);
  });

  it.each([
    ["lat", { lat: 35 }],
    ["lon", { lon: -80 }],
    ["state", { state: "SC" }],
  ])("replaces when only %s is restated (so validation fails as it always did)", (_key, location) => {
    expect(mergeFacilityPatch(existing, { location }).location).toEqual(location);
  });

  it("replaces when a restated pin comes with its own precision, clearing omitted optional keys", () => {
    const complete = { lat: 1, lon: 2, state: "SC", precision: "approximate" };
    expect(mergeFacilityPatch(existing, { location: complete }).location).toEqual(complete);
  });

  it.each([
    ["null", null],
    ["a string", "Atlanta"],
    ["an array", [33.4, -84.4]],
  ])("replaces with a non-object location (%s) so validation can reject it", (_label, location) => {
    expect(mergeFacilityPatch(existing, { location }).location).toBe(location);
  });
});

describe("mergeFacilityPatch — everything else", () => {
  it("replaces every other top-level field wholesale", () => {
    const merged = mergeFacilityPatch(existing, { sources: [{ url: "https://example.com/only" }], name: "New" });
    expect(merged.sources).toEqual([{ url: "https://example.com/only" }]);
    expect(merged.name).toBe("New");
    expect(merged.location).toBe(existing.location);
  });

  it("reads location as an own property only, never one inherited from the patch's prototype", () => {
    const inherited = Object.create({ location: { city: "Inherited" } });
    expect(mergeFacilityPatch(existing, inherited)).toEqual(existing);
  });

  it("does not force or validate id; the caller pins it", () => {
    expect(mergeFacilityPatch(existing, { id: "other" }).id).toBe("other");
  });

  it("does not mutate either argument", () => {
    const base = structuredClone(existing);
    const patch = { location: { city: "New" } };
    mergeFacilityPatch(base, patch);
    expect(base).toEqual(existing);
    expect(patch).toEqual({ location: { city: "New" } });
  });

  it("treats a missing existing doc as empty", () => {
    expect(mergeFacilityPatch(null, { location: { city: "New" } })).toEqual({ location: { city: "New" } });
    expect(mergeFacilityPatch(undefined, { name: "x" })).toEqual({ name: "x" });
  });

  it.each([
    ["null", null],
    ["a string", "abc"],
    ["an array", [1, 2]],
  ])("ignores a patch that is %s instead of spreading its index keys", (_label, patch) => {
    expect(mergeFacilityPatch(existing, patch)).toEqual(existing);
  });
});

describe("isPlainObject", () => {
  it("accepts plain objects and rejects null, arrays and primitives", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], [1], "abc", 1, true]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });
});
