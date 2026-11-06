// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fakeStore } from "./fake-keyed-store";
import { run } from "./backfill-ownership-to-neon";

const SOURCE = [
  { operator: "QTS", owners: [{ name: "Blackstone" }] },
  { operator: "CyrusOne", owners: [{ name: "KKR" }, { name: "GIP" }] },
];

function deps(store: ReturnType<typeof fakeStore> | null, source: unknown = SOURCE) {
  const lines: string[] = [];
  return {
    lines,
    deps: { root: "/repo", readFile: () => JSON.stringify(source), store: () => store, log: (l: string) => lines.push(l) },
  };
}

describe("backfill-ownership-to-neon", () => {
  it("dry-runs without a database", async () => {
    const { deps: d, lines } = deps(null);
    await run([], d);
    expect(lines).toEqual(["operator_ownership: source 2; no DATABASE_URL, would upsert 2"]);
  });

  it("keys rows by the exact operator string and is idempotent", async () => {
    const store = fakeStore();
    await run(["--apply"], deps(store).deps);
    expect([...store.rows.keys()].sort()).toEqual(["CyrusOne", "QTS"]);
    expect(store.rows.get("QTS")).toEqual(SOURCE[0]);

    const second = deps(store);
    await run(["--apply"], second.deps);
    expect(second.lines[0]).toContain("insert 0, update 0, unchanged 2");
  });

  it("refuses, with zero upserts, when an existing Neon row differs from the JSON", async () => {
    const store = fakeStore({ QTS: { operator: "QTS", owners: [{ name: "Someone else" }] } });
    await expect(run(["--apply"], deps(store).deps)).rejects.toThrow(/Neon has moved ahead.*first: QTS/);
    expect(store.upsertCalls).toHaveLength(0);
  });

  it("refuses on a count mismatch", async () => {
    await expect(run(["--apply"], deps(fakeStore({ Other: {} })).deps)).rejects.toThrow(/row count after write is 3, source has 2/);
  });

  it("refuses on a verify mismatch", async () => {
    await expect(run(["--apply"], deps(fakeStore({}, { corruptKey: "QTS" })).deps)).rejects.toThrow(/read-back differs/);
  });

  it("refuses a duplicate operator or a non-array source", async () => {
    await expect(run([], deps(null, [SOURCE[0], SOURCE[0]]).deps)).rejects.toThrow(/twice: QTS/);
    await expect(run([], deps(null, {}).deps)).rejects.toThrow(/not a JSON array/);
    await expect(run([], deps(null, [{ owners: [] }]).deps)).rejects.toThrow(/without an operator/);
  });
});
