import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/data", () => ({
  getFacilityById: vi.fn(async (id: string) => (id === "known-fac" ? { id, name: "Known Facility" } : null)),
}));

import { WATCH_TARGETS, WATCH_TARGET_TYPES } from "@/lib/watch-targets";

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

describe("lib/watch-target-types.ts", () => {
  it("has no imports at all (client-safe)", () => {
    const src = readFileSync(join(process.cwd(), "lib/watch-target-types.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/from\s+["']@\/lib\/(data|db)/);
  });
});
