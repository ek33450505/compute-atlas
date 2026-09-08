import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  diffSitingContext,
  fetchBaselineRef,
  isShallowRepo,
  isAdditive,
  readBaselineFromGit,
  refExists,
  resolveBaselineRef,
} from "./check-siting-additive.mjs";

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

// ---------------------------------------------------------------------------
// Baseline-ref resolution.
//
// The incident these guard against (2026-09-08, run 34227078474): build:mapdata
// takes ~30 min, PR #256 merged 13.5 min into that window correcting two Salt
// Lake City facilities off a shared placeholder centroid, and the guard — still
// diffing against the HEAD checked out at job start — reported their
// recomputed `groundwaterDecline` as DROPPED. The old values had been computed
// at a fabricated coordinate; the absence was correct. Diffing against current
// origin/main is what makes that case pass.
// ---------------------------------------------------------------------------

// `execFileSync` is heavily overloaded (its 1-arg overload is why a 2-param
// vi.fn stub fails to typecheck with "Target signature provides too few
// arguments"). One documented cast here keeps every injection site below
// type-clean without weakening the signature of the code under test.
type ExecStub = (bin: string, args: string[], opts?: unknown) => string;
const asExec = (fn: ExecStub | ReturnType<typeof vi.fn>) =>
  fn as unknown as typeof execFileSync;

describe("readBaselineFromGit — ref selection", () => {
  it("reads the blob from the ref it is given, not hardcoded HEAD", () => {
    mockedExecFileSync.mockReturnValue("{}");

    readBaselineFromGit("/repo", "data/siting-context.json", "origin/main");

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["show", "origin/main:data/siting-context.json"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("still defaults to HEAD when no ref is passed", () => {
    mockedExecFileSync.mockReturnValue("{}");

    readBaselineFromGit("/repo", "data/siting-context.json");

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["show", "HEAD:data/siting-context.json"],
      expect.anything(),
    );
  });
});

describe("refExists", () => {
  it("verifies the ref as a commit so a missing ref cannot be misread as a missing path", () => {
    const exec = vi.fn().mockReturnValue("");

    expect(refExists("/repo", "origin/main", asExec(exec))).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("returns false when the ref does not resolve", () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error("fatal: bad revision"), { status: 128 });
    });

    expect(refExists("/repo", "origin/main", asExec(exec))).toBe(false);
  });
});

describe("fetchBaselineRef", () => {
  // `--depth=1` against a FULL clone rewrites it to a single-commit shallow
  // repo (.git/shallow appears, `git rev-list --count HEAD` -> 1), recoverable
  // only via `git fetch --unshallow`. An earlier draft did this to the local
  // clone on 2026-09-08. The flag must appear ONLY when already shallow.
  const shallowExec = (shallow: boolean) =>
    vi.fn((_bin: string, args: string[]) =>
      args[0] === "rev-parse" && args[1] === "--is-shallow-repository"
        ? `${shallow}\n`
        : "",
    );

  it("passes --depth=1 when the clone is ALREADY shallow (CI)", () => {
    const exec = shallowExec(true);

    expect(fetchBaselineRef("/repo", "origin/main", asExec(exec))).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["fetch", "--depth=1", "origin", "main:refs/remotes/origin/main"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("NEVER passes --depth=1 to a full clone — that would truncate its history", () => {
    const exec = shallowExec(false);

    expect(fetchBaselineRef("/repo", "origin/main", asExec(exec))).toBe(true);
    const fetchCall = exec.mock.calls.find((c) => (c[1] as string[])[0] === "fetch");
    expect(fetchCall?.[1]).toEqual(["fetch", "origin", "main:refs/remotes/origin/main"]);
    expect(fetchCall?.[1]).not.toContain("--depth=1");
  });

  it("treats an unreadable shallow probe as a full clone (non-destructive default)", () => {
    const exec = vi.fn((_bin: string, args: string[]) => {
      if (args[0] === "rev-parse") throw new Error("git broke");
      return "";
    });

    fetchBaselineRef("/repo", "origin/main", asExec(exec));
    const fetchCall = exec.mock.calls.find((c) => (c[1] as string[])[0] === "fetch");
    expect(fetchCall?.[1]).not.toContain("--depth=1");
  });

  it("writes the tracking refspec in full so the fetched ref is the one read back", () => {
    const exec = shallowExec(true);

    fetchBaselineRef("/repo", "origin/main", asExec(exec));
    const fetchCall = exec.mock.calls.find((c) => (c[1] as string[])[0] === "fetch");
    expect(fetchCall?.[1]).toContain("main:refs/remotes/origin/main");
  });

  it("returns false instead of throwing when the network is down", () => {
    const exec = vi.fn(() => {
      throw new Error("could not resolve host");
    });

    expect(fetchBaselineRef("/repo", "origin/main", asExec(exec))).toBe(false);
  });

  it("does not attempt a fetch for a non-remote ref like HEAD", () => {
    const exec = vi.fn();

    expect(fetchBaselineRef("/repo", "HEAD", asExec(exec))).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("resolveBaselineRef", () => {
  it("prefers origin/main when it resolves", () => {
    const exec = vi.fn().mockReturnValue("");

    expect(resolveBaselineRef("/repo", { exec: asExec(exec) })).toEqual({
      ref: "origin/main",
      fellBack: false,
      fetched: true,
    });
  });

  it("falls back to HEAD when origin/main does not resolve", () => {
    // fetch fails AND rev-parse fails — e.g. a clone with no origin remote.
    const exec = vi.fn(() => {
      throw Object.assign(new Error("no such remote"), { status: 128 });
    });

    expect(resolveBaselineRef("/repo", { exec: asExec(exec) })).toEqual({
      ref: "HEAD",
      fellBack: true,
      fetched: false,
    });
  });

  it("still uses origin/main when the fetch fails but the ref exists locally", () => {
    // Stale-but-present origin/main is at-or-behind current origin/main, so its
    // baseline is a superset — the check stays stricter, never more permissive.
    const exec = vi.fn((_bin: string, args: string[]) => {
      if (args[0] === "fetch") throw new Error("network down");
      return "";
    });

    expect(resolveBaselineRef("/repo", { exec: asExec(exec) })).toEqual({
      ref: "origin/main",
      fellBack: false,
      fetched: false,
    });
  });

  it("skips the fetch when noFetch is set", () => {
    const exec = vi.fn().mockReturnValue("");

    expect(resolveBaselineRef("/repo", { exec: asExec(exec), noFetch: true })).toEqual({
      ref: "origin/main",
      fellBack: false,
      fetched: false,
    });
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["fetch"]), expect.anything());
  });

  it("honours an explicit preferred ref override", () => {
    const exec = vi.fn().mockReturnValue("");

    expect(resolveBaselineRef("/repo", { exec: asExec(exec), preferred: "origin/release" }).ref).toBe(
      "origin/release",
    );
  });
});

describe("regression: the 2026-09-08 stale-HEAD false positive", () => {
  // Both facilities sat at the shared placeholder centroid and carried a
  // groundwaterDecline computed there. The correction moved them to real
  // coordinates where that overlay has no coverage (it is absent on 1019 of
  // 1405 records — sparse coverage is the norm for this field).
  const STALE_HEAD = {
    "oracle-salt-lake-city-ut": {
      nearestWater: { name: "City Creek", kind: "river", distanceMi: 1.2 },
      groundwaterDecline: { cat: 1, label: "Low - Medium (0-2 cm/y)" },
    },
    "senawave-salt-lake-city-ut": {
      nearestWater: { name: "City Creek", kind: "river", distanceMi: 1.2 },
      groundwaterDecline: { cat: 1, label: "Low - Medium (0-2 cm/y)" },
    },
  };
  const CORRECTED_MAIN = {
    "oracle-salt-lake-city-ut": {
      nearestWater: { name: "Decker Lake", kind: "lake", distanceMi: 3.3 },
    },
    "senawave-salt-lake-city-ut": {
      nearestWater: { name: "Decker Lake", kind: "lake", distanceMi: 0.6 },
    },
  };
  // What build:mapdata produces from the corrected coordinates.
  const REBUILD = CORRECTED_MAIN;

  it("FAILS against the stale HEAD baseline — the false positive being fixed", () => {
    const diff = diffSitingContext(STALE_HEAD, REBUILD);

    expect(isAdditive(diff)).toBe(false);
    expect(diff.lost.map((l) => `${l.id}.${l.field}`)).toEqual([
      "oracle-salt-lake-city-ut.groundwaterDecline",
      "senawave-salt-lake-city-ut.groundwaterDecline",
    ]);
  });

  it("PASSES against the current origin/main baseline", () => {
    expect(isAdditive(diffSitingContext(CORRECTED_MAIN, REBUILD))).toBe(true);
  });

  it("still catches REAL loss against origin/main — the fix does not blunt the guard", () => {
    const outage = {
      "oracle-salt-lake-city-ut": {},
      "senawave-salt-lake-city-ut": {
        nearestWater: { name: "Decker Lake", kind: "lake", distanceMi: 0.6 },
      },
    };
    const diff = diffSitingContext(CORRECTED_MAIN, outage);

    expect(isAdditive(diff)).toBe(false);
    expect(diff.lost).toHaveLength(1);
    expect(diff.lost[0]).toMatchObject({
      id: "oracle-salt-lake-city-ut",
      field: "nearestWater",
    });
  });
});

describe("isShallowRepo", () => {
  it("reports true only on the literal 'true' from git", () => {
    expect(isShallowRepo("/repo", asExec(vi.fn().mockReturnValue("true\n")))).toBe(true);
    expect(isShallowRepo("/repo", asExec(vi.fn().mockReturnValue("false\n")))).toBe(false);
  });

  it("defaults to false (full clone, no --depth) when git cannot answer", () => {
    expect(
      isShallowRepo(
        "/repo",
        asExec(
          vi.fn(() => {
            throw new Error("nope");
          }),
        ),
      ),
    ).toBe(false);
  });
});
