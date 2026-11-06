// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fakeStore } from "./fake-keyed-store";
import { run } from "./apply-siting-context";

const CURRENT = {
  a: { nearestWater: { name: "River" }, waterStress: { cat: 1 } },
  b: { nearestTransmission: { voltageKv: 230 } },
};
const FACILITIES = [{ id: "a" }, { id: "b" }, { id: "c" }];

function setup(next: unknown, store = fakeStore(CURRENT), facilities: unknown = FACILITIES) {
  const lines: string[] = [];
  const files: Record<string, unknown> = {
    "/repo/data/siting-context.next.json": next,
    "/repo/data/facilities.json": facilities,
  };
  return {
    store,
    lines,
    deps: {
      root: "/repo",
      readFile: (f: string) => JSON.stringify(files[f]),
      store: () => store,
      log: (l: string) => lines.push(l),
    },
  };
}

describe("apply-siting-context", () => {
  it("dry run prints the plan and writes nothing", async () => {
    const s = setup({ ...CURRENT, c: { waterStress: { cat: 3 } } });
    await run([], s.deps);
    expect(s.lines[0]).toContain("add 1, change 0");
    expect(s.store.upsertCalls).toHaveLength(0);
  });

  it("applies only added and changed entries, then a second apply is a no-op", async () => {
    const next = { ...CURRENT, a: { ...CURRENT.a, waterStress: { cat: 2 } }, c: { waterStress: { cat: 3 } } };
    const s = setup(next);
    await run(["--apply"], s.deps);
    expect(s.store.upsertCalls[0].map((r) => r.key).sort()).toEqual(["a", "c"]);
    expect(s.store.rows.get("a")).toEqual(next.a);

    const again = setup(next, s.store);
    await run(["--apply"], again.deps);
    expect(s.store.upsertCalls).toHaveLength(1); // nothing new to write
  });

  it("reordered nested keys in stored rows are not changes: change 0, write 0", async () => {
    // jsonb returns keys in its own order; the next file has the same data.
    const next = {
      a: { nearestWater: { name: "River", kind: "river" }, waterStress: { cat: 1, label: "Low" } },
      b: { nearestTransmission: { voltageKv: 230, distanceMi: 4 } },
    };
    const stored = {
      a: { waterStress: { label: "Low", cat: 1 }, nearestWater: { kind: "river", name: "River" } },
      b: { nearestTransmission: { distanceMi: 4, voltageKv: 230 } },
    };
    const s = setup(next, fakeStore(stored));
    await run(["--apply"], s.deps);
    expect(s.lines[0]).toContain("add 0, change 0");
    expect(s.store.upsertCalls).toHaveLength(0);
  });

  it("new ids insert with DO NOTHING, changed ids with DO UPDATE, in one call", async () => {
    const next = { ...CURRENT, a: { ...CURRENT.a, waterStress: { cat: 2 } }, c: { waterStress: { cat: 3 } } };
    const s = setup(next);
    await run(["--apply"], s.deps);
    expect(s.store.upsertCalls).toHaveLength(1);
    const modes = Object.fromEntries(s.store.upsertCalls[0].map((r) => [r.key, r.onConflict]));
    expect(modes).toEqual({ a: "update", c: "nothing" });
  });

  it("a NEW field on an existing id is written and counted as a change", async () => {
    const next = { ...CURRENT, a: { ...CURRENT.a, nearestTransmission: { voltageKv: 138 } } };
    const dry = setup(next);
    await run([], dry.deps);
    expect(dry.lines[0]).toContain("add 0, change 1");
    expect(dry.store.upsertCalls).toHaveLength(0);

    const s = setup(next);
    await run(["--apply"], s.deps);
    expect(s.lines[0]).toContain("add 0, change 1");
    expect(s.store.upsertCalls[0].map((r) => [r.key, r.onConflict])).toEqual([["a", "update"]]);
    expect(s.store.rows.get("a")).toEqual(next.a);
  });

  it("one non-additive entry blocks the WHOLE apply (value -> null)", async () => {
    const next = { a: { nearestWater: null, waterStress: { cat: 1 } }, b: CURRENT.b, c: { waterStress: { cat: 3 } } };
    const s = setup(next);
    await expect(run(["--apply"], s.deps)).rejects.toThrow(/whole write is blocked.*nulled 1 \[a\.nearestWater\]/);
    expect(s.store.upsertCalls).toHaveLength(0);
    expect(s.store.rows.has("c")).toBe(false);
  });

  it("an id with a new field AND a nulled field is refused whole, with zero upserts", async () => {
    const next = {
      ...CURRENT,
      a: { nearestWater: null, waterStress: { cat: 1 }, nearestTransmission: { voltageKv: 138 } },
      c: { waterStress: { cat: 3 } },
    };
    const s = setup(next);
    await expect(run(["--apply"], s.deps)).rejects.toThrow(/whole write is blocked.*nulled 1 \[a\.nearestWater\]/);
    expect(s.store.upsertCalls).toHaveLength(0);
    expect(s.store.rows.get("a")).toEqual(CURRENT.a);
    expect(s.store.rows.has("c")).toBe(false);
  });

  it("a dry run on a refused diff also rejects, and writes nothing", async () => {
    const s = setup({ a: { nearestWater: null, waterStress: { cat: 1 } }, b: CURRENT.b });
    await expect(run([], s.deps)).rejects.toThrow(/whole write is blocked/);
    expect(s.lines).toEqual([]);
    expect(s.store.upsertCalls).toHaveLength(0);
  });

  it("blocks on a lost field and on a dropped live id", async () => {
    const lost = setup({ a: { nearestWater: { name: "River" } }, b: CURRENT.b });
    await expect(run(["--apply"], lost.deps)).rejects.toThrow(/lost 1 \[a\.waterStress\]/);
    const removed = setup({ a: CURRENT.a });
    await expect(run(["--apply"], removed.deps)).rejects.toThrow(/removed 1 \[b\]/);
  });

  it("treats a dropped id absent from facilities.json as a pruned orphan, not a failure", async () => {
    const s = setup({ a: CURRENT.a }, fakeStore(CURRENT), [{ id: "a" }]);
    await run(["--apply"], s.deps);
    expect(s.lines[0]).toContain("pruned-not-deleted 1");
    expect(s.store.rows.has("b")).toBe(true);
  });

  it("a missing next file is a clear refusal, not a stack trace", async () => {
    const s = setup(CURRENT);
    s.deps.readFile = (f: string) => {
      if (f.endsWith("siting-context.next.json")) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      return JSON.stringify(FACILITIES);
    };
    await expect(run([], s.deps)).rejects.toThrow("no siting-context.next.json; build:mapdata emits it from PR B onward");
  });

  it("refuses when the read-back differs from what was written", async () => {
    const store = fakeStore(CURRENT, { corruptKey: "c" });
    const s = setup({ ...CURRENT, c: { waterStress: { cat: 3 } } }, store);
    await expect(run(["--apply"], s.deps)).rejects.toThrow(/read-back differs from source for 1 row\(s\) \(first: c\)/);
  });

  it("fails closed on an empty facilities.json", async () => {
    await expect(run([], setup(CURRENT, fakeStore(CURRENT), []).deps)).rejects.toThrow(/unreadable or empty/);
  });
});
