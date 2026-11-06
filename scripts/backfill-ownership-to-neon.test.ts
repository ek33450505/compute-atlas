// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

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
    deps: { root: "/repo", readFile: () => JSON.stringify(source), store: () => store, log: (l: string) => lines.push(l),
      env: { API_BASE_URL: "https://example.test", API_ADMIN_TOKEN: "t" },
      fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    },
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
    const d = deps(store).deps;
    await expect(run(["--apply"], d)).rejects.toThrow(/Neon has moved ahead.*first: QTS/);
    expect(store.upsertCalls).toHaveLength(0);
    expect(d.fetchImpl).not.toHaveBeenCalled();
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

  describe("cache busts", () => {
    const ENV = { API_BASE_URL: "https://example.test", API_ADMIN_TOKEN: "sekret" };
    const ok = () => vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const bustedTags = (f: ReturnType<typeof ok>) => f.mock.calls.flatMap(([, init]) => JSON.parse(init.body).tags);

    const SRC = [{ operator: "QTS", owners: [] }, { operator: "Cyrus One", owners: [] }];
    const mk = (store: ReturnType<typeof fakeStore> | null, env: Record<string, string | undefined> = ENV, fetchImpl = ok()) => ({
      root: "/repo",
      readFile: () => JSON.stringify(SRC),
      store: () => store,
      log: () => {},
      env,
      fetchImpl,
    });

    it("busts exactly the inserted rows plus facilities, not unchanged rows", async () => {
      const f = ok();
      await run(["--apply"], mk(fakeStore({ QTS: SRC[0] }), ENV, f));
      expect(bustedTags(f).sort()).toEqual(["facilities", "operator:cyrus-one"]);
    });

    it("busts nothing when every row is unchanged", async () => {
      const f = ok();
      await run(["--apply"], mk(fakeStore({ QTS: SRC[0], "Cyrus One": SRC[1] }), ENV, f));
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
    });

    it("missing env refuses before any write", async () => {
      const store = fakeStore();
      await expect(run(["--apply"], mk(store, { API_ADMIN_TOKEN: "sekret" }))).rejects.toThrow(/API_BASE_URL/);
      expect(store.upsertCalls).toHaveLength(0);
    });

    it("a read-back failure after the write still busts the written rows and rethrows it", async () => {
      const f = ok();
      await expect(run(["--apply"], mk(fakeStore({}, { corruptKey: "QTS" }), ENV, f))).rejects.toThrow(/read-back differs/);
      expect(bustedTags(f).sort()).toEqual(["facilities", "operator:cyrus-one", "operator:qts"]);
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
