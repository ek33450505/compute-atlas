import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/data", () => ({
  getFacilityById: vi.fn(async (id: string) => (id === "known-fac" ? { id, name: "Known Facility" } : null)),
  getCountyBySlug: vi.fn(async (slug: string) =>
    slug.toLowerCase() === "loudoun-va" ? { slug: "loudoun-va", name: "Loudoun", state: "VA", count: 3 } : undefined
  ),
}));

import { normalizeWatchTargetId } from "@/lib/watch-target-types";
import { WATCH_TARGETS, WATCH_TARGET_TYPES, watchAreasEnabled } from "@/lib/watch-targets";

describe("WATCH_TARGETS", () => {
  it("resolves a known facility id to its name", async () => {
    expect(await WATCH_TARGETS.facility.resolve("known-fac")).toEqual({ id: "known-fac", label: "Known Facility" });
  });

  it("resolves a known state code", async () => {
    expect(await WATCH_TARGETS.state.resolve("CA")).toEqual({ id: "CA", label: "California" });
  });

  it("normalises a lowercase state code", async () => {
    expect(await WATCH_TARGETS.state.resolve("ca")).toEqual({ id: "CA", label: "California" });
  });

  it("returns null for unknown ids", async () => {
    expect(await WATCH_TARGETS.facility.resolve("nope")).toBeNull();
    expect(await WATCH_TARGETS.state.resolve("ZZ")).toBeNull();
  });

  it("keeps the exact error strings, cadence and family", () => {
    expect(WATCH_TARGETS.facility).toMatchObject({ notFoundError: "Unknown facility", cadence: "instant", family: "facility" });
    expect(WATCH_TARGETS.state).toMatchObject({ notFoundError: "Unknown state", cadence: "monthly", family: "area" });
  });

  it("WATCH_TARGET_TYPES equals the registry keys", () => {
    expect([...WATCH_TARGET_TYPES].sort()).toEqual(Object.keys(WATCH_TARGETS).sort());
  });
});

describe("county and metro targets", () => {
  it("resolves a known county, canonicalising case", async () => {
    const expected = { id: "loudoun-va", label: "Loudoun County, VA" };
    expect(await WATCH_TARGETS.county.resolve("loudoun-va")).toEqual(expected);
    expect(await WATCH_TARGETS.county.resolve(WATCH_TARGETS.county.normalizeId(" Loudoun-VA "))).toEqual(expected);
  });

  it("resolves a metro, including one spanning two states", async () => {
    expect(await WATCH_TARGETS.metro.resolve("northern-virginia")).toMatchObject({ id: "northern-virginia" });
    expect(await WATCH_TARGETS.metro.resolve("new-york-city")).toMatchObject({ id: "new-york-city" });
    expect(await WATCH_TARGETS.metro.resolve(WATCH_TARGETS.metro.normalizeId("Kansas-City"))).toMatchObject({
      id: "kansas-city",
    });
  });

  it("returns null for unknown ids", async () => {
    expect(await WATCH_TARGETS.county.resolve("nowhere-zz")).toBeNull();
    expect(await WATCH_TARGETS.metro.resolve("atlantis")).toBeNull();
  });

  it("is monthly/area with the exact error strings", () => {
    expect(WATCH_TARGETS.county).toMatchObject({ notFoundError: "Unknown county", cadence: "monthly", family: "area" });
    expect(WATCH_TARGETS.metro).toMatchObject({ notFoundError: "Unknown metro", cadence: "monthly", family: "area" });
  });
});

describe("normalisers", () => {
  it("matches each registry entry, and falls back to trim for unknown types", async () => {
    expect(WATCH_TARGETS.facility.normalizeId("Fac-1 ")).toBe("Fac-1");
    expect(WATCH_TARGETS.state.normalizeId(" ca ")).toBe("CA");
    // Padded input now resolves where it used to 400 (intended).
    expect(await WATCH_TARGETS.state.resolve(WATCH_TARGETS.state.normalizeId(" tx "))).toEqual({ id: "TX", label: "Texas" });
    expect(normalizeWatchTargetId("county", "Loudoun-VA")).toBe("loudoun-va");
    expect(normalizeWatchTargetId("mystery", " AbC ")).toBe("AbC");
  });
});

describe("watchAreasEnabled", () => {
  const original = process.env.WATCH_AREAS_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.WATCH_AREAS_ENABLED;
    else process.env.WATCH_AREAS_ENABLED = original;
  });

  it("is ON unless explicitly \"false\"", () => {
    delete process.env.WATCH_AREAS_ENABLED;
    expect(watchAreasEnabled()).toBe(true);
    process.env.WATCH_AREAS_ENABLED = "true";
    expect(watchAreasEnabled()).toBe(true);
    process.env.WATCH_AREAS_ENABLED = "";
    expect(watchAreasEnabled()).toBe(true);
    process.env.WATCH_AREAS_ENABLED = "false";
    expect(watchAreasEnabled()).toBe(false);
  });
});

describe("lib/watch-target-types.ts", () => {
  it("has no imports at all (client-safe)", () => {
    const src = readFileSync(join(process.cwd(), "lib/watch-target-types.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/from\s+["']@\/lib\/(data|db)/);
  });
});
