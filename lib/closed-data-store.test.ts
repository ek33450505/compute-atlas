// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fakeStore } from "../scripts/fake-keyed-store";
import { applyKeyed, formatApplyReport } from "./closed-data-store";

const label = "t";

describe("applyKeyed", () => {
  it("refuses a removal in apply mode with nothing written", async () => {
    const store = fakeStore({ A: { v: 1 }, Gone: { v: 9 } });
    await expect(
      applyKeyed({ source: new Map([["A", { v: 2 }]]), store, apply: true, label }),
    ).rejects.toThrow(/Gone.*removals are never applied; nothing was written/);
    expect(store.upsertCalls).toHaveLength(0);
    expect(store.rows.get("A")).toEqual({ v: 1 });
  });

  it("reports a removal in a dry run without throwing or writing", async () => {
    const store = fakeStore({ Gone: { v: 9 } });
    const r = await applyKeyed({ source: new Map([["A", { v: 1 }]]), store, apply: false, label });
    expect(r.removals).toEqual(["Gone"]);
    expect(r.applied).toBe(false);
    expect(store.upsertCalls).toHaveLength(0);
    expect(formatApplyReport(label, r)).toContain("--apply would REFUSE");
  });

  it("inserts and updates with onConflict update, leaves unchanged rows alone", async () => {
    const store = fakeStore({ Old: { v: 1 }, Same: { v: 1 } });
    const source = new Map<string, unknown>([["Old", { v: 2 }], ["New", { v: 1 }], ["Same", { v: 1 }]]);
    const r = await applyKeyed({ source, store, apply: true, label });
    expect(r.applied).toBe(true);
    expect(store.upsertCalls).toHaveLength(1);
    expect(store.upsertCalls[0].map((x) => [x.key, x.onConflict]).sort()).toEqual([["New", "update"], ["Old", "update"]]);
    expect(store.rows.get("Old")).toEqual({ v: 2 });
    expect(formatApplyReport(label, r)).toBe("t (applied): source 3; insert 1, update 1, unchanged 1");
  });

  it("makes no upsert call when nothing differs", async () => {
    const store = fakeStore({ A: { v: 1 } });
    await applyKeyed({ source: new Map([["A", { v: 1 }]]), store, apply: true, label });
    expect(store.upsertCalls).toHaveLength(0);
  });

  it("refuses when the read-back differs", async () => {
    const store = fakeStore({}, { corruptKey: "A" });
    await expect(applyKeyed({ source: new Map([["A", { v: 1 }]]), store, apply: true, label })).rejects.toThrow(/read-back differs/);
  });

  it("refuses when the row count after the write differs from the source", async () => {
    const store = fakeStore();
    const source = new Map<string, unknown>([["A", 1]]);
    // A sibling row appears mid-run: the verified rows match but the table is bigger.
    const racing = {
      ...store,
      async upsert(rows: Parameters<typeof store.upsert>[0]) {
        await store.upsert(rows);
        store.rows.set("Sneaky", 1);
      },
    };
    await expect(applyKeyed({ source, store: racing, apply: true, label })).rejects.toThrow(/row count after write is 2, source has 1/);
  });

  it("dry-runs without a store and refuses --apply without one", async () => {
    const source = new Map([["A", 1]]);
    const r = await applyKeyed({ source, store: null, apply: false, label });
    expect(r.plan).toBeNull();
    await expect(applyKeyed({ source, store: null, apply: true, label })).rejects.toThrow(/needs DATABASE_URL/);
  });
});
