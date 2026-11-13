import { describe, expect, it } from "vitest";

import { diffSitingContext, isAdditive, runCheck } from "./check-siting-additive.mjs";


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

  it("does not report `changed` when only object key order differs (Neon jsonb re-orders keys)", () => {
    const oldObj = { "site-a": { nearestWater: { name: "River A", kind: "river", distanceMi: 1.2 } } };
    const newObj = { "site-a": { nearestWater: { kind: "river", name: "River A", distanceMi: 1.2 } } };

    expect(diffSitingContext(oldObj, newObj).changed).toEqual([]);
  });

  it("does not report `changed` when only NESTED object key order differs", () => {
    const oldObj = { "site-a": { waterStress: { basin: { id: 7, label: "X" }, bands: [{ a: 1, b: 2 }] } } };
    const newObj = { "site-a": { waterStress: { bands: [{ b: 2, a: 1 }], basin: { label: "X", id: 7 } } } };

    expect(diffSitingContext(oldObj, newObj).changed).toEqual([]);
  });

  it("reports `changed` when a value changes type (1 vs \"1\")", () => {
    const diff = diffSitingContext({ "site-a": { score: 1 } }, { "site-a": { score: "1" } });

    expect(diff.changed).toHaveLength(1);
  });

  it("reports `changed` for an array of objects with one changed nested value", () => {
    const oldObj = { "site-a": { bands: [{ a: 1, b: 2 }, { a: 3, b: 4 }] } };
    const newObj = { "site-a": { bands: [{ b: 2, a: 1 }, { b: 5, a: 3 }] } };

    expect(diffSitingContext(oldObj, newObj).changed).toHaveLength(1);
  });

  it("still reports `changed` for a real value change under reordered keys, and for array order", () => {
    const oldObj = { "site-a": { nearestWater: { name: "River A", distanceMi: 1.2 } }, "site-b": { tags: [1, 2] } };
    const newObj = { "site-a": { nearestWater: { distanceMi: 0.9, name: "River A" } }, "site-b": { tags: [2, 1] } };

    expect(diffSitingContext(oldObj, newObj).changed.map((c) => c.id)).toEqual(["site-a", "site-b"]);
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

    expect(diff).toEqual({
      added: [],
      removed: [],
      pruned: [],
      lost: [],
      nulled: [],
      changed: [],
    });
    expect(isAdditive(diff)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pruned vs removed — the orphan-facility discriminator.
//
// Incident this guards against (2026-09-29): a full/--backfill-nhd build:mapdata
// run seeds the siting-context id set from facilities ∪ computed results, so a
// facility retired by a raw Neon delete (no longer in data/facilities.json) has
// its siting-context entry legitimately dropped on the next such run. Without a
// discriminator this guard cannot tell that apart from real data loss.
// ---------------------------------------------------------------------------

describe("diffSitingContext — pruned (orphan) vs removed (real loss)", () => {
  it("classifies a dropped id as `pruned`, not `removed`, when it is absent from liveIds", () => {
    const oldObj = {
      "retired-facility": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
    };
    const newObj = {};
    const liveIds = new Set<string>(); // the facility is gone from data/facilities.json too

    const diff = diffSitingContext(oldObj, newObj, liveIds);

    expect(diff.pruned).toEqual(["retired-facility"]);
    expect(diff.removed).toEqual([]);
    expect(isAdditive(diff)).toBe(true);
  });

  it("classifies a dropped id as `removed`, not `pruned`, when it is STILL in liveIds", () => {
    const oldObj = {
      "still-live-facility": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
    };
    const newObj = {};
    const liveIds = new Set(["still-live-facility"]); // present in data/facilities.json

    const diff = diffSitingContext(oldObj, newObj, liveIds);

    expect(diff.removed).toEqual(["still-live-facility"]);
    expect(diff.pruned).toEqual([]);
    expect(isAdditive(diff)).toBe(false);
  });

  it("falls back to legacy behaviour (everything -> removed) when liveIds is omitted", () => {
    const oldObj = {
      "some-facility": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
    };
    const newObj = {};

    const diff = diffSitingContext(oldObj, newObj);

    expect(diff.removed).toEqual(["some-facility"]);
    expect(diff.pruned).toEqual([]);
    expect(isAdditive(diff)).toBe(false);
  });

  it("classifies a mix of one orphan and one live-removed id independently", () => {
    const oldObj = {
      "retired-facility": { nearestWater: { name: "River A", kind: "river", distanceMi: 1 } },
      "still-live-facility": { nearestWater: { name: "River B", kind: "river", distanceMi: 2 } },
    };
    const newObj = {};
    const liveIds = new Set(["still-live-facility"]);

    const diff = diffSitingContext(oldObj, newObj, liveIds);

    expect(diff.pruned).toEqual(["retired-facility"]);
    expect(diff.removed).toEqual(["still-live-facility"]);
    expect(isAdditive(diff)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readBaselineFromGit — must fail loudly on anything that isn't the genuine
// "no baseline at HEAD" case (git exit 128). Swallowing ENOENT, permission
// errors, or a corrupt/truncated baseline blob would silently disable the
// data-loss guard while the caller still reports green.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// runCheck: exit-code contract with injected readers (no Neon, no git, no fs).
// Codes are literal on purpose: importing the script's own constants would make
// the assertion unable to fail.
// ---------------------------------------------------------------------------

type Entries = Record<string, Record<string, unknown>>;
const WATER = { name: "River A" };
const FACILITIES = [{ id: "a" }];

async function check(opts: {
  current?: Entries | Error;
  next?: Entries | Error;
  facilities?: unknown;
}) {
  const out: string[] = [];
  const base: Entries = { a: { nearestWater: WATER } };
  const { current = base, next = base, facilities = FACILITIES } = opts;
  const code = await runCheck({
    readNext: () => {
      if (next instanceof Error) throw next;
      return next;
    },
    readCurrent: async () => {
      if (current instanceof Error) throw current;
      return current;
    },
    readFacilities: () => facilities,
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  });
  return { code, text: out.join("\n") };
}

describe("runCheck", () => {
  it("exits 0 when next is additive", async () => {
    const r = await check({
      current: { a: { nearestWater: WATER } },
      next: { a: { nearestWater: WATER }, b: {} },
    });
    expect(r.code).toBe(0);
  });

  it("exits 2, not 0, when Neon has no rows (an empty baseline checks nothing)", async () => {
    const r = await check({ current: {}, next: { a: {} } });
    expect(r.code).toBe(2);
    expect(r.text).toContain("siting_context is empty: run `npm run backfill:siting -- --apply` first");
  });

  it("exits 1 on a dropped field for a live facility", async () => {
    const r = await check({ current: { a: { nearestWater: WATER } }, next: { a: {} } });
    expect(r.code).toBe(1);
    expect(r.text).toContain("DATA LOSS DETECTED");
  });

  it("exits 1 on value -> null with no confirmed absence", async () => {
    const r = await check({
      current: { a: { nearestWater: WATER } },
      next: { a: { nearestWater: null } },
    });
    expect(r.code).toBe(1);
    expect(r.text).toContain("Fields nulled");
  });

  it("exits 1 when a live facility's entry is dropped (removed)", async () => {
    expect((await check({ current: { a: {} }, next: {} })).code).toBe(1);
  });

  it("exits 0 when a dropped id has no facility (pruned)", async () => {
    const r = await check({
      current: { a: {}, gone: { nearestWater: WATER } },
      next: { a: {} },
    });
    expect(r.code).toBe(0);
    expect(r.text).toContain("pruned:  1");
  });

  it("direction matters: a removal fails, the same pair reversed is an addition", async () => {
    // Guards the 'swap the sides' mutation.
    const facilities = [{ id: "a" }, { id: "b" }];
    expect((await check({ current: { a: {}, b: {} }, next: { a: {} }, facilities })).code).toBe(1);
    expect((await check({ current: { a: {} }, next: { a: {}, b: {} }, facilities })).code).toBe(0);
  });

  it.each([
    ["an empty facilities list", { facilities: [] }],
    ["a non-array facilities value", { facilities: {} }],
    ["an unreadable next file", { next: new Error("ENOENT") }],
    ["a failing Neon read", { current: new Error("boom") }],
  ])("exits 2, not a verdict, for %s", async (_name, opts) => {
    const r = await check(opts);
    expect(r.code).toBe(2);
    expect(r.text).toContain("GUARD ERROR");
    expect(r.text).not.toContain("DATA LOSS");
  });

  it("does not relay a Neon read error message (could carry bound params)", async () => {
    const r = await check({ current: new Error("Failed query: ... params: secret@example.com") });
    expect(r.text).not.toContain("secret@example.com");
  });
});

describe("diffSitingContext — joinKeys (nested object, diffed as a whole value)", () => {
  const jk = { countyFips: "51107", tractGeoid: "51107611000", egridSubregion: "SRVC", pin: { lat: 39, lon: -77.5, precision: "exact" } };

  it("a new joinKeys on an existing id is additive", () => {
    const diff = diffSitingContext({ a: { waterStress: "high" } }, { a: { waterStress: "high", joinKeys: jk } });
    expect(isAdditive(diff)).toBe(true);
  });

  it("a changed countyFips on a moved pin is a legitimate change, not a loss", () => {
    const moved = { ...jk, countyFips: "51059", pin: { lat: 38.9, lon: -77.5, precision: "exact" } };
    const diff = diffSitingContext({ a: { joinKeys: jk } }, { a: { joinKeys: moved } });
    expect(diff.changed).toHaveLength(1);
    expect(isAdditive(diff)).toBe(true);
  });

  it("removing joinKeys entirely is refused", () => {
    const diff = diffSitingContext({ a: { joinKeys: jk } }, { a: {} });
    expect(diff.lost).toEqual([{ id: "a", field: "joinKeys", oldValue: jk }]);
    expect(isAdditive(diff)).toBe(false);
  });

  it("setting joinKeys to null is refused", () => {
    const diff = diffSitingContext({ a: { joinKeys: jk } }, { a: { joinKeys: null } });
    expect(diff.nulled).toHaveLength(1);
    expect(isAdditive(diff)).toBe(false);
  });

  it("dropping a SUBKEY inside joinKeys (confirmed no_polygon, precision downgrade) is NOT caught: the guard compares the whole value", () => {
    const without: Partial<typeof jk> = { ...jk };
    delete without.tractGeoid;
    const diff = diffSitingContext({ a: { joinKeys: jk } }, { a: { joinKeys: without } });
    expect(diff.lost).toEqual([]);
    expect(isAdditive(diff)).toBe(true);
  });
});
