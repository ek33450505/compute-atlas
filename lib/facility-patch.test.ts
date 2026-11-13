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

describe("mergeFacilityPatch — curated nested keys survive a parent-object patch", () => {
  const curated = {
    id: "site",
    facilityType: "data_center",
    capacityMw: { operational: 50, basis: "it", itPlanned: 80 },
    energy: { source: "grid", utility: "U", utilityEiaId: 123 },
  };

  it("carries itPlanned, drops the stale basis, and replaces the non-curated operational", () => {
    const merged = mergeFacilityPatch(curated, { capacityMw: { planned: 100 } });
    expect(merged.capacityMw).toStrictEqual({ planned: 100, itPlanned: 80 });
    expect(merged.capacityMw).not.toHaveProperty("operational");
  });

  it("lets a patch that states basis itself win", () => {
    const merged = mergeFacilityPatch(curated, { capacityMw: { planned: 100, basis: "facility" } });
    expect(merged.capacityMw).toStrictEqual({ planned: 100, basis: "facility", itPlanned: 80 });
  });

  it("carries itOperational too", () => {
    const merged = mergeFacilityPatch(
      { ...curated, capacityMw: { operational: 5, itOperational: 4 } },
      { capacityMw: { operational: 6 } }
    );
    expect(merged.capacityMw).toStrictEqual({ operational: 6, itOperational: 4 });
  });

  it("keeps utilityEiaId only while the utility is unchanged", () => {
    expect(mergeFacilityPatch(curated, { energy: { source: "grid", utility: "U" } }).energy).toStrictEqual({
      source: "grid",
      utility: "U",
      utilityEiaId: 123,
    });
    expect(mergeFacilityPatch(curated, { energy: { source: "grid", utility: "X" } }).energy).toStrictEqual({
      source: "grid",
      utility: "X",
    });
    expect(mergeFacilityPatch(curated, { energy: { source: "grid" } }).energy).toStrictEqual({ source: "grid" });
  });

  it("keeps basis when planned and operational are unchanged, drops it when planned changes", () => {
    expect(mergeFacilityPatch(curated, { capacityMw: { operational: 50 } }).capacityMw).toStrictEqual({
      operational: 50,
      basis: "it",
      itPlanned: 80,
    });
    expect(mergeFacilityPatch(curated, { capacityMw: { operational: 50, planned: 70 } }).capacityMw).toStrictEqual({
      operational: 50,
      planned: 70,
      itPlanned: 80,
    });
  });

  it("drops basis when operational is removed", () => {
    const withBoth = { ...curated, capacityMw: { planned: 100, operational: 50, basis: "it" } };
    expect(mergeFacilityPatch(withBoth, { capacityMw: { planned: 100 } }).capacityMw).toStrictEqual({ planned: 100 });
  });

  it("keeps an explicit null in the merged doc so schema validation rejects it", () => {
    const merged = mergeFacilityPatch(curated, { capacityMw: { operational: 50, basis: null } });
    expect(merged.capacityMw).toStrictEqual({ operational: 50, basis: null, itPlanned: 80 });
    expect(mergeFacilityPatch(curated, { energy: { utility: "U", utilityEiaId: null } }).energy).toStrictEqual({
      utility: "U",
      utilityEiaId: null,
    });
  });

  it("does not carry capacityMw keys when the merged facilityType is power_generation", () => {
    const merged = mergeFacilityPatch(curated, {
      facilityType: "power_generation",
      capacityMw: { operational: 9 },
    });
    expect(merged.capacityMw).toStrictEqual({ operational: 9 });
  });

  it("does not carry basis when the patch empties the MW figures", () => {
    expect(mergeFacilityPatch(curated, { capacityMw: {} }).capacityMw).toStrictEqual({ itPlanned: 80 });
  });

  it("returns the existing objects unchanged when the patch omits capacityMw and energy", () => {
    const merged = mergeFacilityPatch(curated, { name: "N" });
    expect(merged.capacityMw).toBe(curated.capacityMw);
    expect(merged.energy).toBe(curated.energy);
  });

  it("does not mutate its inputs", () => {
    const before = structuredClone(curated);
    const patch = { capacityMw: { planned: 100 }, energy: { utility: "X" } };
    const patchBefore = structuredClone(patch);
    mergeFacilityPatch(curated, patch);
    expect(curated).toStrictEqual(before);
    expect(patch).toStrictEqual(patchBefore);
  });
});
