import path from "node:path";
import { describe, it, expect, vi } from "vitest";

import { ensureDataSnapshot, SNAPSHOT_FILES, type SnapshotDeps } from "./ensure-data-snapshot";

const ROOT = "/repo";

function makeDeps(
  over: Partial<SnapshotDeps> & { existing?: string[] } = {}
): SnapshotDeps & { copies: Array<[string, string]> } {
  const existing = new Set(over.existing ?? []);
  const copies: Array<[string, string]> = [];
  return {
    root: ROOT,
    env: {},
    fs: {
      existsSync: (p) => existing.has(p),
      copyFileSync: (src, dest) => void copies.push([src, dest]),
      mkdirSync: () => undefined,
    },
    exportFacilities: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    warn: vi.fn(),
    ...over,
    copies,
  };
}

const ALL = SNAPSHOT_FILES.map((f) => path.join(ROOT, f.snapshot));
const without = (...snaps: string[]) => ALL.filter((p) => !snaps.some((s) => p.endsWith(s)));
const copiedDests = (copies: Array<[string, string]>) => copies.map(([, d]) => d);

const failingExport = () =>
  vi.fn().mockRejectedValue(
    Object.assign(new Error("postgres://user:secret@host/db failed"), { code: "ECONNREFUSED" })
  );

function expectFixturesCopied(copies: Array<[string, string]>) {
  expect(copies).toEqual(
    SNAPSHOT_FILES.map((f) => [path.join(ROOT, f.fixture), path.join(ROOT, f.snapshot)])
  );
}

describe("ensureDataSnapshot", () => {
  it("Vercel production: a failed export exits non-zero and copies no fixtures", async () => {
    const deps = makeDeps({
      env: { VERCEL: "1", VERCEL_ENV: "production" },
      exportFacilities: failingExport(),
    });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(1);
    expect(deps.copies).toEqual([]);
  });

  it("Vercel production: a successful export exits 0 without fixtures", async () => {
    const deps = makeDeps({ env: { VERCEL: "1", VERCEL_ENV: "production" } });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(deps.exportFacilities).toHaveBeenCalledOnce();
    expect(deps.copies).toEqual([]);
  });

  it("Vercel preview: a failed export falls back to fixtures with a loud warning", async () => {
    const deps = makeDeps({
      env: { VERCEL: "1", VERCEL_ENV: "preview" },
      exportFacilities: failingExport(),
    });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expectFixturesCopied(deps.copies);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
  });

  it("local: existing data/facilities.json is a no-op", async () => {
    const deps = makeDeps({ existing: ALL });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(deps.exportFacilities).not.toHaveBeenCalled();
    expect(deps.copies).toEqual([]);
  });

  it("local: missing data/facilities.json copies all four fixtures and warns", async () => {
    const deps = makeDeps();
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(deps.exportFacilities).not.toHaveBeenCalled();
    expectFixturesCopied(deps.copies);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
  });

  it("local: only siting-context absent copies just that file", async () => {
    const deps = makeDeps({ existing: without("data/siting-context.json") });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(copiedDests(deps.copies)).toEqual([path.join(ROOT, "data/siting-context.json")]);
  });

  it("local: facilities.json present but meta absent warns and copies no meta", async () => {
    const deps = makeDeps({ existing: without("data/facilities.meta.json") });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(deps.copies).toEqual([]);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("facilities.meta.json"));
  });

  it("never overwrites an existing file: facilities.json absent copies the pair only", async () => {
    const deps = makeDeps({
      existing: without("data/facilities.json", "data/facilities.meta.json"),
    });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(copiedDests(deps.copies)).toEqual([
      path.join(ROOT, "data/facilities.json"),
      path.join(ROOT, "data/facilities.meta.json"),
    ]);
  });

  it("facilities.json absent but meta present: copies both, leaves siting and ownership alone", async () => {
    const deps = makeDeps({ existing: without("data/facilities.json") });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(copiedDests(deps.copies)).toEqual([
      path.join(ROOT, "data/facilities.json"),
      path.join(ROOT, "data/facilities.meta.json"),
    ]);
  });

  it("a missing DATABASE_URL is reported as such, not as an unknown DB error", async () => {
    const err = Object.assign(new Error("DATABASE_URL is not set."), {
      name: "MissingDatabaseUrlError",
    });
    const deps = makeDeps({ exportFacilities: vi.fn().mockRejectedValue(err) });
    expect(await ensureDataSnapshot({ forceExport: true }, deps)).toBe(1);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL not set"));
    expect(deps.warn).not.toHaveBeenCalledWith(expect.stringContaining("unknown"));
  });

  it("Vercel preview: failed export with all files present leaves them alone and warns", async () => {
    const deps = makeDeps({
      env: { VERCEL: "1", VERCEL_ENV: "preview" },
      existing: ALL,
      exportFacilities: failingExport(),
    });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(deps.copies).toEqual([]);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("left as they are"));
  });

  it("Vercel with VERCEL_ENV unset or unknown: a failed export fails closed", async () => {
    for (const env of [{ VERCEL: "1" }, { VERCEL: "1", VERCEL_ENV: "development" }]) {
      const deps = makeDeps({ env, exportFacilities: failingExport() });
      expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(1);
      expect(deps.copies).toEqual([]);
    }
  });

  it("CI with a missing snapshot file and no override fails closed without copying", async () => {
    const deps = makeDeps({ env: { CI: "true" }, existing: without("data/siting-context.json") });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(1);
    expect(deps.copies).toEqual([]);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("ALLOW_FIXTURE_SNAPSHOT"));
  });

  it("NODE_ENV=production with a missing snapshot file fails closed without copying", async () => {
    const deps = makeDeps({ env: { NODE_ENV: "production" } });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(1);
    expect(deps.copies).toEqual([]);
  });

  it("CI with ALLOW_FIXTURE_SNAPSHOT=1 copies the fixtures and exits 0", async () => {
    const deps = makeDeps({ env: { CI: "true", ALLOW_FIXTURE_SNAPSHOT: "1" } });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expectFixturesCopied(deps.copies);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
  });

  it("CI with ALLOW_FIXTURE_SNAPSHOT=1, facilities.json present and meta missing: warns, copies no meta", async () => {
    const deps = makeDeps({
      env: { CI: "true", ALLOW_FIXTURE_SNAPSHOT: "1" },
      existing: without("data/facilities.meta.json"),
    });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(deps.copies).toEqual([]);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("facilities.meta.json"));
  });

  it("CI with every snapshot file present is a no-op", async () => {
    const deps = makeDeps({ env: { CI: "true", NODE_ENV: "production" }, existing: ALL });
    expect(await ensureDataSnapshot({ forceExport: false }, deps)).toBe(0);
    expect(deps.copies).toEqual([]);
  });

  it("--export forces an export even when the snapshot exists", async () => {
    const deps = makeDeps({ existing: [path.join(ROOT, "data/facilities.json")] });
    expect(await ensureDataSnapshot({ forceExport: true }, deps)).toBe(0);
    expect(deps.exportFacilities).toHaveBeenCalledOnce();
    expect(deps.copies).toEqual([]);
  });

  it("--export exits non-zero on failure and never falls back to fixtures", async () => {
    const deps = makeDeps({ exportFacilities: failingExport() });
    expect(await ensureDataSnapshot({ forceExport: true }, deps)).toBe(1);
    expect(deps.copies).toEqual([]);
  });

  it("logs only the error code, never the message (URLs / params)", async () => {
    const deps = makeDeps({
      env: { VERCEL: "1", VERCEL_ENV: "production" },
      exportFacilities: failingExport(),
    });
    await ensureDataSnapshot({ forceExport: false }, deps);
    const logged = [...vi.mocked(deps.warn).mock.calls, ...vi.mocked(deps.log).mock.calls]
      .flat()
      .join("\n");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("postgres://");
  });
});
