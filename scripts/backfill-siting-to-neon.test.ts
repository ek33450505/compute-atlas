// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fakeStore } from "./fake-keyed-store";
import { run } from "./backfill-siting-to-neon";

const SOURCE = {
  a: { nearestWater: { name: "River", kind: "river", distanceMi: 1.2 }, waterStress: { cat: 2, label: "Low" } },
  b: { nearestTransmission: { voltageKv: 345, distanceMi: 4 } },
};

function deps(store: ReturnType<typeof fakeStore> | null, source: unknown = SOURCE) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      root: "/repo",
      readFile: () => JSON.stringify(source),
      store: () => store,
      log: (l: string) => lines.push(l),
    },
  };
}

describe("backfill-siting-to-neon", () => {
  it("dry-runs without a database and reports would-upsert", async () => {
    const { deps: d, lines } = deps(null);
    await run([], d);
    expect(lines).toEqual(["siting_context: source 2; no DATABASE_URL, would upsert 2"]);
  });

  it("dry run with a store plans but writes nothing", async () => {
    const store = fakeStore({ a: SOURCE.a });
    const { deps: d, lines } = deps(store);
    await run([], d);
    expect(lines[0]).toContain("insert 1, update 0, unchanged 1");
    expect(store.upsertCalls).toHaveLength(0);
  });

  it("refuses --apply without a database", async () => {
    await expect(run(["--apply"], deps(null).deps)).rejects.toThrow(/DATABASE_URL/);
  });

  it("applies, and an all-unchanged re-run succeeds with no writes (key order is irrelevant)", async () => {
    const store = fakeStore();
    await run(["--apply"], deps(store).deps);
    expect(store.rows.size).toBe(2);

    // jsonb does not keep key order: reorder the stored value, expect 0 changes.
    store.rows.set("a", { waterStress: SOURCE.a.waterStress, nearestWater: SOURCE.a.nearestWater });
    const second = deps(store);
    await run(["--apply"], second.deps);
    expect(second.lines[0]).toContain("insert 0, update 0, unchanged 2");
    expect(store.upsertCalls[1]).toEqual([]);
  });

  it("only inserts the missing rows into a partly filled table", async () => {
    const store = fakeStore({ a: SOURCE.a });
    await run(["--apply"], deps(store).deps);
    expect(store.upsertCalls[0].map((r) => r.key)).toEqual(["b"]);
  });

  it("refuses, with zero upserts, when an existing Neon row differs from the JSON", async () => {
    const store = fakeStore({ a: { newerInNeon: true } });
    await expect(run(["--apply"], deps(store).deps)).rejects.toThrow(
      "Neon has moved ahead of the committed JSON; backfill refuses to overwrite 1 existing row(s) (first: a)",
    );
    expect(store.upsertCalls).toHaveLength(0);
    expect(store.rows.get("a")).toEqual({ newerInNeon: true });
  });

  it("a dry run flags that --apply would refuse", async () => {
    const { deps: d, lines } = deps(fakeStore({ a: { newerInNeon: true } }));
    await run([], d);
    expect(lines[0]).toContain("--apply would REFUSE");
  });

  it("refuses when the row count after the write differs from the source", async () => {
    const store = fakeStore({ extra: {} });
    await expect(run(["--apply"], deps(store).deps)).rejects.toThrow(/row count after write is 3, source has 2/);
  });

  it("refuses when a row is dropped by the write", async () => {
    const store = fakeStore({}, { dropKey: "b" });
    await expect(run(["--apply"], deps(store).deps)).rejects.toThrow(/read-back differs from source for 1 row\(s\) \(first: b\)/);
  });

  it("refuses when the read-back differs from the source", async () => {
    const store = fakeStore({}, { corruptKey: "b" });
    await expect(run(["--apply"], deps(store).deps)).rejects.toThrow(/read-back differs from source for 1 row\(s\) \(first: b\)/);
  });

  it("rejects a non-object source and unknown args", async () => {
    await expect(run([], deps(null, []).deps)).rejects.toThrow(/not a JSON object/);
    await expect(run(["--force"], deps(null).deps)).rejects.toThrow(/unknown argument/);
  });
});
