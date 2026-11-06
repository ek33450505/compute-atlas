// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ledgerStore, ownershipStore, sitingStore, syncKeyed, type KeyedStore } from "@/lib/closed-data-store";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb(); // applies every migration in drizzle/, including 0019
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

const SOURCE = new Map<string, unknown>([
  ["a", { nearestWater: { name: "River", distanceMi: 1.5 }, waterStress: { cat: 2, label: "Low" } }],
  ["b", { nearestTransmission: { voltageKv: 345, distanceMi: 4 } }],
  ["c", { list: [1, { z: 1, y: 2 }] }],
]);

const stores: Array<[string, () => KeyedStore]> = [
  ["siting_context", () => sitingStore(tdb.db)],
  ["operator_ownership", () => ownershipStore(tdb.db)],
  ["maintenance_ledger", () => ledgerStore(tdb.db)],
];

describe.each(stores)("%s via neonStoreFor + syncKeyed (real Postgres)", (label, make) => {
  it("first apply inserts everything, second apply changes nothing", async () => {
    const first = await syncKeyed({ source: SOURCE, store: make(), apply: true, label });
    expect(first.plan).toMatchObject({ unchanged: 0 });
    expect(first.plan?.insert).toHaveLength(3);
    expect(first.applied).toBe(true);

    const second = await syncKeyed({ source: SOURCE, store: make(), apply: true, label });
    expect(second.plan?.insert).toHaveLength(0);
    expect(second.plan?.update).toHaveLength(0);
    expect(second.plan?.unchanged).toBe(3);
  });

  it("an all-unchanged re-run is allowed and writes nothing", async () => {
    const store = make();
    await syncKeyed({ source: SOURCE, store, apply: true, label });
    await tdb.client.exec(`UPDATE "${label}" SET updated_at = '2000-06-01T00:00:00Z'`);
    const r = await syncKeyed({ source: SOURCE, store, apply: true, label });
    expect(r.plan?.unchanged).toBe(3);
    const old = await tdb.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${label}" WHERE updated_at < '2001-01-01'`,
    );
    expect(old.rows[0].n).toBe(3); // no row was touched
  });

  it("refuses to overwrite an existing row that differs, writing nothing at all", async () => {
    const store = make();
    await store.upsert([{ key: "b", data: { newerInNeon: true } }]);
    const calls: number[] = [];
    const spy: KeyedStore = { readAll: () => store.readAll(), upsert: async (r) => { calls.push(r.length); return store.upsert(r); } };
    await expect(syncKeyed({ source: SOURCE, store: spy, apply: true, label })).rejects.toThrow(
      /Neon has moved ahead of the committed JSON; backfill refuses to overwrite 1 existing row\(s\) \(first: b\)/,
    );
    expect(calls).toEqual([]);
    const rows = await store.readAll();
    expect([...rows.keys()]).toEqual(["b"]); // the missing rows were not inserted either
    expect(rows.get("b")).toEqual({ newerInNeon: true });
  });

  it("one batch call carries mixed DO NOTHING and DO UPDATE rows, and both land", async () => {
    const batches: number[] = [];
    const batching = new Proxy(tdb.db, {
      get(target, prop, recv) {
        if (prop === "batch") {
          return async (qs: PromiseLike<unknown>[]) => {
            batches.push(qs.length);
            for (const q of qs) await q;
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const mk = { siting_context: sitingStore, operator_ownership: ownershipStore, maintenance_ledger: ledgerStore }[
      label as "siting_context"
    ];
    const store = mk(batching as typeof tdb.db);
    await store.upsert([{ key: "old", data: { v: 1 } }]);
    batches.length = 0;
    await store.upsert([
      { key: "old", data: { v: 2 }, onConflict: "update" },
      { key: "new", data: { v: 1 }, onConflict: "nothing" },
      { key: "old", data: { SHOULD: "not apply" }, onConflict: "nothing" }, // key clash: DO NOTHING must leave it to the update
    ]);
    expect(batches).toEqual([2]); // one call: one nothing-chunk + one update-chunk
    const rows = await store.readAll();
    expect(rows.get("old")).toEqual({ v: 2 });
    expect(rows.get("new")).toEqual({ v: 1 });
  });

  it("a row another writer inserts mid-run is not overwritten; the verify flags it", async () => {
    const real = make();
    const racing: KeyedStore = {
      readAll: () => real.readAll(),
      async upsert(rows) {
        // the competing writer lands after the plan, before our insert
        await real.upsert([{ key: "b", data: { other: "writer" } }]);
        await real.upsert(rows);
      },
    };
    await expect(syncKeyed({ source: SOURCE, store: racing, apply: true, label })).rejects.toThrow(
      /read-back differs from source for 1 row\(s\) \(first: b\)/,
    );
    expect((await real.readAll()).get("b")).toEqual({ other: "writer" });
  });

  it.each([
    ["a reordered array", { list: [2, 1] }, { list: [1, 2] }],
    ['"1" vs 1', { n: "1" }, { n: 1 }],
  ])("does not treat %s as equal", async (_name, stored, source) => {
    const store = make();
    await store.upsert([{ key: "k", data: stored }]);
    await expect(syncKeyed({ source: new Map([["k", source]]), store, apply: true, label })).rejects.toThrow(
      /Neon has moved ahead/,
    );
  });

  it("uses db.batch when the driver has one (the Neon path), in a single call", async () => {
    const batches: number[] = [];
    const batching = new Proxy(tdb.db, {
      get(target, prop, recv) {
        if (prop === "batch") {
          return async (qs: PromiseLike<unknown>[]) => {
            batches.push(qs.length);
            for (const q of qs) await q; // PGlite has no batch: emulate sequentially
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const big = new Map<string, unknown>(Array.from({ length: 1200 }, (_, i) => [`k${i}`, { i }]));
    const mk = { siting_context: sitingStore, operator_ownership: ownershipStore, maintenance_ledger: ledgerStore }[
      label as "siting_context"
    ];
    const r = await syncKeyed({ source: big, store: mk(batching as typeof tdb.db), apply: true, label });
    expect(r.applied).toBe(true);
    expect(batches).toEqual([3]); // 1200 rows = 3 chunks of 500, one batch call
  });

  it("jsonb key order does not matter for the verify", async () => {
    // Source declares keys in the opposite order to how jsonb returns them.
    const source = new Map<string, unknown>([["k", { zeta: 1, alpha: { y: 1, x: 2 }, mid: [{ b: 1, a: 2 }] }]]);
    const r = await syncKeyed({ source, store: make(), apply: true, label });
    expect(r.applied).toBe(true);
    const again = await syncKeyed({ source, store: make(), apply: true, label });
    expect(again.plan?.unchanged).toBe(1);
  });

  it("refuses when an extra row exists in the table", async () => {
    const store = make();
    await store.upsert([{ key: "stray", data: {} }]);
    await expect(syncKeyed({ source: SOURCE, store, apply: true, label })).rejects.toThrow(/row count after write is 4, source has 3/);
  });

  it("refuses when a row is tampered with between write and verify", async () => {
    const real = make();
    const tampering: KeyedStore = {
      readAll: () => real.readAll(),
      async upsert(rows) {
        await real.upsert(rows);
        await real.upsert([{ key: "b", data: { tampered: true } }]); // concurrent writer
      },
    };
    await expect(syncKeyed({ source: SOURCE, store: tampering, apply: true, label })).rejects.toThrow(
      /read-back differs from source for 1 row\(s\) \(first: b\)/,
    );
  });
});
