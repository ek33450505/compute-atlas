import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { diffSitingContext, isAdditive, readBaselineFromGit } from "./check-siting-additive.mjs";

// Explicit factory (not a bare `vi.mock("node:child_process")`) — automock of
// this node builtin does not produce a mock function under this project's
// vitest config (verified: `vi.isMockFunction(execFileSync)` is false without
// a factory), so the bare form silently leaves `execFileSync` un-mockable.
// The .mjs source under test is loaded via Node's ESM/CJS interop, which
// requires a `default` export alongside the named one, or vitest throws
// "No default export is defined on the ... mock" before any test runs. The
// factory body is hoisted above imports, so the mock fn must be created
// inline (not referenced from an outer `const`) to avoid a TDZ error.
vi.mock("node:child_process", () => {
  const execFileSync = vi.fn();
  return { execFileSync, default: { execFileSync } };
});

const mockedExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// diffSitingContext / isAdditive — pure, no I/O, no git, no fs.
//
// The incident these guard against: a scattered partial fetch outage in
// build-map-data.mjs silently OMITS a field (or nulls it) from a facility's
// entry while the build still exits 0. `changed` must NOT trip the guard —
// a genuinely nearer feature or a refreshed basin label is a legitimate
// refresh, not data loss.
// ---------------------------------------------------------------------------

describe("diffSitingContext / isAdditive", () => {
  it("treats a purely additive change (new ids only) as additive", () => {
    const oldObj = {
      "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
    };
    const newObj = {
      "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
      "site-b": { nearestWater: { name: "River B", kind: "river", distanceMi: 2 } },
    };

    const diff = diffSitingContext(oldObj, newObj);

    expect(diff.added).toEqual(["site-b"]);
    expect(diff.removed).toEqual([]);
    expect(diff.lost).toEqual([]);
    expect(diff.nulled).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(isAdditive(diff)).toBe(true);
  });

  it("flags a field that disappears from an entry as `lost` and non-additive", () => {
    const oldObj = {
      "site-a": {
        nearestWater: { name: "River A", kind: "river", distanceMi: 1 },
        nearestTransmission: { voltageKv: 345, distanceMi: 4 },
      },
    };
    const newObj = {
      // nearestWater silently omitted — the exact shape of the real bug
      "site-a": { nearestTransmission: { voltageKv: 345, distanceMi: 4 } },
    };

    const diff = diffSitingContext(oldObj, newObj);

    expect(diff.lost).toEqual([
      {
        id: "site-a",
        field: "nearestWater",
        oldValue: { name: "River A", kind: "river", distanceMi: 1 },
      },
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.nulled).toEqual([]);
    expect(isAdditive(diff)).toBe(false);
  });

  it("flags a field going to null as `nulled` and non-additive", () => {
    const oldObj = {
      "site-a": { waterStress: { cat: 3, label: "High" } },
    };
    const newObj = {
      "site-a": { waterStress: null },
    };

    const diff = diffSitingContext(oldObj, newObj);

    expect(diff.nulled).toEqual([
      { id: "site-a", field: "waterStress", oldValue: { cat: 3, label: "High" } },
    ]);
    expect(diff.lost).toEqual([]);
    expect(isAdditive(diff)).toBe(false);
  });

  it("flags an entire entry disappearing as `removed` and non-additive", () => {
    const oldObj = {
      "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
      "site-b": { nearestWater: { name: "River B", kind: "river", distanceMi: 2 } },
    };
    const newObj = {
      "site-b": { nearestWater: { name: "River B", kind: "river", distanceMi: 2 } },
    };

    const diff = diffSitingContext(oldObj, newObj);

    expect(diff.removed).toEqual(["site-a"]);
    expect(isAdditive(diff)).toBe(false);
  });

  it("reports a value changing to a DIFFERENT non-null value as `changed`, and stays additive", () => {
    // The important case: a genuinely nearer feature found on rebuild, or a
    // refreshed basin label, must NOT trip the guard.
    const oldObj = {
      "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 1.2 } },
    };
    const newObj = {
      "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 0.9 } },
    };

    const diff = diffSitingContext(oldObj, newObj);

    expect(diff.changed).toEqual([
      {
        id: "site-a",
        field: "nearestWater",
        oldValue: { name: "River A", kind: "river", distanceMi: 1.2 },
        newValue: { name: "River A", kind: "river", distanceMi: 0.9 },
      },
    ]);
    expect(diff.lost).toEqual([]);
    expect(diff.nulled).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(isAdditive(diff)).toBe(true);
  });

  it("treats an empty old object as additive (first-ever build)", () => {
    const oldObj = {};
    const newObj = {
      "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
    };

    const diff = diffSitingContext(oldObj, newObj);

    expect(diff.added).toEqual(["site-a"]);
    expect(diff.removed).toEqual([]);
    expect(diff.lost).toEqual([]);
    expect(diff.nulled).toEqual([]);
    expect(isAdditive(diff)).toBe(true);
  });

  it("treats two identical objects as additive with no changes at all", () => {
    const obj = {
      "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
    };

    const diff = diffSitingContext(obj, obj);

    expect(diff).toEqual({ added: [], removed: [], lost: [], nulled: [], changed: [] });
    expect(isAdditive(diff)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readBaselineFromGit — must fail loudly on anything that isn't the genuine
// "no baseline at HEAD" case (git exit 128). Swallowing ENOENT, permission
// errors, or a corrupt/truncated baseline blob would silently disable the
// data-loss guard while the caller still reports green.
// ---------------------------------------------------------------------------

describe("readBaselineFromGit", () => {
  it("returns null when git exits 128 (path not found at HEAD — the legitimate first-run case)", () => {
    const err = Object.assign(new Error("fatal: path not in HEAD"), { status: 128 });
    mockedExecFileSync.mockImplementation(() => {
      throw err;
    });

    expect(readBaselineFromGit("/repo", "data/siting-context.json")).toBeNull();
  });

  it("throws when git is missing from PATH (ENOENT, no status) instead of returning null", () => {
    const err = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    mockedExecFileSync.mockImplementation(() => {
      throw err;
    });

    expect(() => readBaselineFromGit("/repo", "data/siting-context.json")).toThrow(err);
  });

  it("throws on a non-128 git failure (e.g. permission denied, status 1) instead of returning null", () => {
    const err = Object.assign(new Error("fatal: permission denied"), { status: 1 });
    mockedExecFileSync.mockImplementation(() => {
      throw err;
    });

    expect(() => readBaselineFromGit("/repo", "data/siting-context.json")).toThrow(err);
  });

  it("throws on a corrupt/truncated baseline blob instead of treating it as no baseline", () => {
    mockedExecFileSync.mockReturnValue("{not json");

    expect(() => readBaselineFromGit("/repo", "data/siting-context.json")).toThrow();
  });

  it("returns the parsed object on a valid baseline read", () => {
    mockedExecFileSync.mockReturnValue('{"site-a":{"nearestWater":{"name":"River A"}}}');

    expect(readBaselineFromGit("/repo", "data/siting-context.json")).toEqual({
      "site-a": { nearestWater: { name: "River A" } },
    });
  });
});
