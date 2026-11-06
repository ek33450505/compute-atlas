// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

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
      env: { API_BASE_URL: "https://example.test", API_ADMIN_TOKEN: "t" },
      fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
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
    const d = deps(store).deps;
    await expect(run(["--apply"], d)).rejects.toThrow(
      "Neon has moved ahead of the committed JSON; backfill refuses to overwrite 1 existing row(s) (first: a)",
    );
    expect(store.upsertCalls).toHaveLength(0);
    expect(d.fetchImpl).not.toHaveBeenCalled();
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

  describe("cache busts", () => {
    const ENV = { API_BASE_URL: "https://example.test", API_ADMIN_TOKEN: "sekret" };
    const ok = () => vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const bustedTags = (f: ReturnType<typeof ok>) => f.mock.calls.flatMap(([, init]) => JSON.parse(init.body).tags);

    const SRC = { a: { waterStress: { cat: 1 } }, b: { waterStress: { cat: 2 } } };
    const lines: string[] = [];
    const mk = (store: ReturnType<typeof fakeStore> | null, env: Record<string, string | undefined> = ENV, fetchImpl = ok()) => ({
      root: "/repo",
      readFile: () => JSON.stringify(SRC),
      store: () => store,
      log: (l: string) => lines.push(l),
      env,
      fetchImpl,
    });

    it("busts exactly the inserted rows plus facilities, not unchanged rows", async () => {
      const f = ok();
      await run(["--apply"], mk(fakeStore({ a: { waterStress: { cat: 1 } } }), ENV, f));
      expect(bustedTags(f).sort()).toEqual(["facilities", "facility:b"]);
    });

    it("busts nothing when every row is unchanged", async () => {
      const f = ok();
      await run(["--apply"], mk(fakeStore({ a: { waterStress: { cat: 1 } }, b: { waterStress: { cat: 2 } } }), ENV, f));
      expect(f).not.toHaveBeenCalled();
    });

    it("a dry run makes no fetch, even without env", async () => {
      const f = ok();
      await run([], mk(fakeStore(), {}, f));
      expect(f).not.toHaveBeenCalled();
    });

    it("--skip-revalidate writes and makes no fetch", async () => {
      const f = ok();
      const store = fakeStore();
      await run(["--apply", "--skip-revalidate"], mk(store, {}, f));
      expect(f).not.toHaveBeenCalled();
      expect(store.upsertCalls).toHaveLength(1);
      expect(lines.join("\n")).toContain("WARNING: --skip-revalidate");
    });

    it("missing env refuses before any write", async () => {
      const store = fakeStore();
      await expect(run(["--apply"], mk(store, { API_ADMIN_TOKEN: "sekret" }))).rejects.toThrow(/API_BASE_URL/);
      expect(store.upsertCalls).toHaveLength(0);
    });

    it("a read-back failure after the write still busts the written rows and rethrows it", async () => {
      const f = ok();
      await expect(run(["--apply"], mk(fakeStore({}, { corruptKey: "b" }), ENV, f))).rejects.toThrow(/read-back differs/);
      expect(bustedTags(f).sort()).toEqual(["facilities", "facility:a", "facility:b"]);
    });

    it("a bust failure keeps the write, warns with status only, and rejects", async () => {
      const f = vi.fn().mockResolvedValue(new Response("leak sekret", { status: 500 }));
      const store = fakeStore();
      const err = await run(["--apply"], mk(store, ENV, f)).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/write succeeded and is kept.*500/);
      expect((err as Error).message).not.toMatch(/sekret/);
      expect(store.rows.size).toBe(2);
    });

  });
});
