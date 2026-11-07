// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { fakeStore } from "./fake-keyed-store";
import { run } from "./apply-ownership";

const owner = {
  name: "Blackstone",
  kind: "organization",
  role: "controlling_owner",
  since: "2021-08",
  source: { url: "https://example.com/a", label: "A", retrievedAt: "2026-11-04", kind: "filing", publisher: "P" },
  asOf: "2026-11-04",
};
const QTS = { operator: "QTS Data Centers", owners: [owner] };
const CYRUS = { operator: "CyrusOne", owners: [{ ...owner, name: "KKR" }] };
const UNCHANGED = { operator: "Unchanged", owners: [{ ...owner, name: "Fidelity" }] };
const CYRUS_V2 = { operator: "CyrusOne", owners: [{ ...owner, name: "KKR", stakePct: 40 }] };

function setup(store: ReturnType<typeof fakeStore> | null, source: unknown, fetchImpl?: typeof fetch) {
  const lines: string[] = [];
  const read = vi.fn((_f: string) => JSON.stringify(source));
  const fetchMock = vi.fn(fetchImpl ?? (async () => new Response("{}", { status: 200 })));
  return {
    lines,
    read,
    fetchMock,
    deps: {
      root: "/repo",
      readFile: read,
      store: () => store,
      log: (l: string) => lines.push(l),
      env: { API_BASE_URL: "https://example.test", API_ADMIN_TOKEN: "t" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    },
  };
}

const bustedTags = (f: ReturnType<typeof vi.fn>): string[] =>
  f.mock.calls.flatMap((c) => JSON.parse((c[1] as { body: string }).body).tags as string[]);

describe("ownership:apply", () => {
  it("dry-runs without a database", async () => {
    const s = setup(null, [QTS, CYRUS]);
    await run([], s.deps);
    expect(s.lines[0]).toContain("no DATABASE_URL");
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("dry-runs against a store with counts and writes nothing", async () => {
    const store = fakeStore({ CyrusOne: CYRUS });
    const s = setup(store, [QTS, CYRUS_V2]);
    await run([], s.deps);
    expect(s.lines[0]).toBe("operator_ownership (dry run): source 2; insert 1, update 1, unchanged 0");
    expect(store.upsertCalls).toHaveLength(0);
  });

  it("applies inserts and updates, then busts deduped operator tags plus facilities", async () => {
    const store = fakeStore({ CyrusOne: CYRUS, Unchanged: UNCHANGED });
    const s = setup(store, [QTS, CYRUS_V2, UNCHANGED]);
    await run(["--apply"], s.deps);
    expect(store.rows.get("CyrusOne")).toEqual(CYRUS_V2);
    expect(store.rows.get("QTS Data Centers")).toEqual(QTS);
    // The unchanged operator is not written, so its rail is not busted.
    expect(bustedTags(s.fetchMock).sort()).toEqual(["facilities", "operator:cyrusone", "operator:qts-data-centers"]);
  });

  it("reads --file instead of the default", async () => {
    const s = setup(null, [QTS]);
    await run(["--file", "plans/x.json"], s.deps);
    expect(s.read).toHaveBeenCalledWith("/repo/plans/x.json");
    const d = setup(null, [QTS]);
    await run([], d.deps);
    expect(d.read).toHaveBeenCalledWith("/repo/data/operator-ownership.json");
  });

  it("refuses a removal in dry run (warns) and in apply (nothing written, no bust)", async () => {
    const store = fakeStore({ QTS: QTS, "Dropped Op": { operator: "Dropped Op", owners: [owner] } });
    const dry = setup(store, [QTS]);
    await run([], dry.deps);
    expect(dry.lines[0]).toMatch(/WARNING 2 Neon row\(s\) are not in the file/);

    const s = setup(store, [QTS, CYRUS]);
    await expect(run(["--apply"], s.deps)).rejects.toThrow(/removals are never applied; nothing was written/);
    expect(store.upsertCalls).toHaveLength(0);
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a schema-invalid file and duplicate operators before touching the store", async () => {
    const store = fakeStore();
    const storeFn = vi.fn(() => store);
    const bad = setup(store, [{ operator: "X", owners: [] }]);
    await expect(run([], { ...bad.deps, store: storeFn })).rejects.toThrow(/fails operatorOwnershipFileSchema/);
    const dup = setup(store, [QTS, QTS]);
    await expect(run([], { ...dup.deps, store: storeFn })).rejects.toThrow(/lists operator twice: QTS Data Centers/);
    expect(storeFn).not.toHaveBeenCalled();
  });

  it("turns a missing file and unparseable JSON into fixed-text refusals", async () => {
    const missing = setup(null, [QTS]);
    missing.read.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: /secret/path"), { code: "ENOENT" });
    });
    await expect(run(["--file", "nope.json"], missing.deps)).rejects.toThrow(/^nope\.json: file not found$/);
    const bad = setup(null, [QTS]);
    bad.read.mockReturnValue('{"operator": "SECRET-SNIPPET" oops');
    const err = await run([], bad.deps).catch((e: Error) => e);
    expect(err).toMatchObject({ message: "data/operator-ownership.json: not valid JSON" });
    expect((err as Error).message).not.toContain("SECRET");
  });

  it("parses arguments before reading the file or store", async () => {
    const s = setup(null, [QTS]);
    await expect(run(["--bogus"], s.deps)).rejects.toThrow(/unknown argument/);
    await expect(run(["--file"], s.deps)).rejects.toThrow(/--file needs a path/);
    expect(s.read).not.toHaveBeenCalled();
  });

  it("keeps the write and surfaces a bust failure without throwing the original", async () => {
    const store = fakeStore();
    const s = setup(store, [QTS], async () => new Response("no", { status: 500 }));
    await expect(run(["--apply"], s.deps)).rejects.toThrow(/write succeeded and is kept/);
    expect(store.rows.get("QTS Data Centers")).toEqual(QTS);
  });

  it("--apply needs API env before writing, unless --skip-revalidate", async () => {
    const store = fakeStore();
    const s = setup(store, [QTS]);
    await expect(run(["--apply"], { ...s.deps, env: {} })).rejects.toThrow(/API_BASE_URL/);
    expect(store.upsertCalls).toHaveLength(0);
    const skip = setup(store, [QTS]);
    await run(["--apply", "--skip-revalidate"], { ...skip.deps, env: {} });
    expect(store.rows.size).toBe(1);
    expect(skip.lines.some((l) => l.startsWith("WARNING: --skip-revalidate: wrote without busting"))).toBe(true);
    expect(skip.fetchMock).not.toHaveBeenCalled();
  });
});
