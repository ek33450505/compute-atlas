import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { byOperator, type OperatorOwnership } from "../lib/operator-ownership";
import {
  MIN_FACILITIES,
  MIN_OWNERSHIP_ROWS,
  MIN_SITING_ROWS,
  buildExportMeta,
  exportSnapshot,
  parseDirArg,
  type SnapshotSource,
} from "./export";

describe("buildExportMeta", () => {
  it("builds the facilities.meta.json shape from a record count", () => {
    const now = new Date("2026-07-28T12:00:00.000Z");

    const meta = buildExportMeta(723, now);

    expect(meta).toEqual({
      asOf: "2026-07-28T12:00:00.000Z",
      recordCount: 723,
      schemaVersion: 1,
    });
  });

  it("defaults asOf to the current time when now is omitted", () => {
    const before = Date.now();

    const meta = buildExportMeta(0);

    const after = Date.now();
    const asOfMs = new Date(meta.asOf).getTime();
    expect(asOfMs).toBeGreaterThanOrEqual(before);
    expect(asOfMs).toBeLessThanOrEqual(after);
  });

  it("carries recordCount through unchanged and writes no sourceRelease key", () => {
    const meta = buildExportMeta(0, new Date("2026-01-01T00:00:00.000Z"));

    expect(meta.recordCount).toBe(0);
    expect(meta).not.toHaveProperty("sourceRelease");
    expect(meta.schemaVersion).toBe(1);
  });
});

describe("exportSnapshot", () => {
  const fx = (name: string) => path.resolve(__dirname, "../tests/fixtures", name);
  const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
  const facilitiesFx: Array<{ id: string }> = readJson(fx("facilities.fixture.json"));
  const sitingFx: Record<string, unknown> = readJson(fx("siting-context.fixture.json"));
  const ownershipFx: OperatorOwnership[] = readJson(fx("operator-ownership.fixture.json"));
  const small = { facilities: 1, siting: 1, ownership: 1 };

  const source = (over: Partial<Record<"facilities" | "siting" | "ownership", unknown[]>> = {}): SnapshotSource =>
    ({
      facilities: async () => (over.facilities ?? facilitiesFx).map((doc) => ({ doc })),
      sitingContext: async () =>
        over.siting ?? Object.entries(sitingFx).map(([facilityId, data]) => ({ facilityId, data })),
      operatorOwnership: async () => (over.ownership ?? ownershipFx).map((data) => ({ data })),
    }) as SnapshotSource;

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "export-snapshot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (src: SnapshotSource, extra = {}) =>
    exportSnapshot({ dir, source: src, floors: small, warn: vi.fn(), ...extra });
  const snapshot = () =>
    Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), "utf-8")]));

  it("writes all four files and round-trips the fixtures in content and formatting", async () => {
    const result = await run(source());
    expect(readdirSync(dir).sort()).toEqual([
      "facilities.json",
      "facilities.meta.json",
      "operator-ownership.json",
      "siting-context.json",
    ]);
    expect(result.count).toBe(facilitiesFx.length);
    expect(readJson(path.join(dir, "facilities.json"))).toEqual(facilitiesFx);
    expect(readJson(path.join(dir, "siting-context.json"))).toEqual(sitingFx);
    // Ownership order is curated in the committed file and not stored in Neon: content is compared as a set...
    const written: Array<{ operator: string }> = readJson(path.join(dir, "operator-ownership.json"));
    const byName = (a: { operator: string }, b: { operator: string }) => a.operator.localeCompare(b.operator);
    expect([...written].sort(byName)).toEqual([...ownershipFx].sort(byName));
    // ...and the WRITTEN order is asserted directly. The fixture rows are fed in non-sorted order, so this can fail.
    const fed = ownershipFx.map((o) => o.operator);
    expect(fed).not.toEqual([...ownershipFx].sort(byOperator).map((o) => o.operator));
    expect(written.map((o) => o.operator)).toEqual([...ownershipFx].sort(byOperator).map((o) => o.operator));
    const meta = readJson(path.join(dir, "facilities.meta.json"));
    expect(meta).toMatchObject({ recordCount: facilitiesFx.length, schemaVersion: 1 });
    // Byte-level: siting key order and entry key order match the committed file.
    expect(readFileSync(path.join(dir, "siting-context.json"), "utf-8")).toBe(
      readFileSync(fx("siting-context.fixture.json"), "utf-8")
    );
    expect(readFileSync(path.join(dir, "facilities.json"), "utf-8")).toBe(
      readFileSync(fx("facilities.fixture.json"), "utf-8")
    );
    for (const f of readdirSync(dir)) expect(readFileSync(path.join(dir, f), "utf-8")).toMatch(/[}\]]\n$/);
  });

  it("a re-export of unchanged data is byte-identical (meta aside)", async () => {
    await run(source());
    const first = snapshot();
    await run(source());
    const second = snapshot();
    delete first["facilities.meta.json"];
    delete second["facilities.meta.json"];
    expect(second).toEqual(first);
  });

  it("drops JSON-null siting fields", async () => {
    const [[id, entry]] = Object.entries(sitingFx);
    await run(source({ siting: [{ facilityId: id, data: { ...(entry as object), aquifer: null } }] }));
    const out = readJson(path.join(dir, "siting-context.json"));
    expect(out[id]).not.toHaveProperty("aquifer");
  });

  it("an invalid record leaves the existing files byte-identical and no temp files", async () => {
    await run(source());
    const before = snapshot();
    const bad = [{ facilityId: "x", data: { nearestWater: { name: 1 } } }];
    await expect(run(source({ siting: bad }))).rejects.toThrow();
    await expect(run(source({ ownership: [{ operator: "x" }] }))).rejects.toThrow();
    await expect(run(source({ facilities: [{ id: "nope" }] }))).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("a failure while writing a temp file unlinks the temps and leaves the old files", async () => {
    await run(source());
    const before = snapshot();
    // A directory squatting on the last temp path makes that write fail after earlier temps exist.
    const squat = path.join(dir, `operator-ownership.json.tmp-${process.pid}`);
    mkdirSync(squat);
    // The original write error (EISDIR) surfaces; the failing cleanup of the squatted path does not mask it.
    await expect(run(source())).rejects.toMatchObject({ code: "EISDIR" });
    rmSync(squat, { recursive: true });
    expect(snapshot()).toEqual(before);
  });

  it("each floor throws and writes nothing", async () => {
    const real = { warn: vi.fn(), dir, source: source() };
    await expect(exportSnapshot(real)).rejects.toThrow(/facilities/);
    await expect(run(source({ siting: [] }))).rejects.toThrow(/siting_context/);
    await expect(run(source({ ownership: [] }))).rejects.toThrow(/operator_ownership/);
    expect(readdirSync(dir)).toEqual([]);
  });

  describe("default floors (no override)", () => {
    const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}` }));
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ facilityId: `f${i}`, data: {} }));
    const fake = (f: number, s: number, o: number): SnapshotSource => ({
      facilities: async () => docs(f).map((doc) => ({ doc })) as never,
      sitingContext: async () => rows(s),
      operatorOwnership: async () => Array.from({ length: o }, () => ({ data: {} })),
    });
    const go = (src: SnapshotSource) => exportSnapshot({ dir, source: src, warn: vi.fn() });

    it("siting floor", async () => {
      await expect(go(fake(2900, 0, 24))).rejects.toThrow(/siting_context.*2900/);
    });
    it("ownership floor", async () => {
      await expect(go(fake(2900, 2900, 23))).rejects.toThrow(/operator_ownership.*24/);
    });
    it("sits exactly at each boundary: one under throws, the floor itself passes the floor check", async () => {
      await expect(go(fake(2900, 2899, 24))).rejects.toThrow(/siting_context.*2900/);
      // At the floors the floor checks pass; the minimal docs then fail schema validation instead.
      await expect(go(fake(2900, 2900, 24))).rejects.not.toThrow(/below the floor/);
    });
    it("facilities floor", async () => {
      await expect(go(fake(2899, 2900, 24))).rejects.toThrow(/facilities.*2900/);
    });
  });

  it("pins the production floors", () => {
    expect([MIN_FACILITIES, MIN_SITING_ROWS, MIN_OWNERSHIP_ROWS]).toEqual([2900, 2900, 24]);
  });

  it("warns, by count only, about siting rows with no facility, and still exports them", async () => {
    const warn = vi.fn();
    const [[, entry]] = Object.entries(sitingFx);
    const siting = [
      ...Object.entries(sitingFx).map(([facilityId, data]) => ({ facilityId, data })),
      { facilityId: "retired-orphan-xx", data: entry },
    ];
    const result = await run(source({ siting }), { warn });
    expect(result.orphanSiting).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 siting_context rows have no matching facility"));
    expect(readJson(path.join(dir, "siting-context.json"))).toHaveProperty("retired-orphan-xx");
  });

  it("warns about facilities lacking siting without throwing", async () => {
    const warn = vi.fn();
    const [first, ...rest] = Object.entries(sitingFx);
    const result = await run(
      source({ siting: rest.map(([facilityId, data]) => ({ facilityId, data })) }),
      { warn }
    );
    expect(first).toBeDefined();
    expect(result.missingSiting).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no siting_context row"));
  });
});

describe("parseDirArg", () => {
  const cwd = "/repo";
  it("defaults to <cwd>/data and accepts data/ or a path inside it", () => {
    expect(parseDirArg([], cwd)).toBe("/repo/data");
    expect(parseDirArg(["--dir=data"], cwd)).toBe("/repo/data");
    expect(parseDirArg(["--dir=data/sub"], cwd)).toBe("/repo/data/sub");
  });
  it("rejects an empty or blank value", () => {
    expect(() => parseDirArg(["--dir="], cwd)).toThrow(/needs a path/);
    expect(() => parseDirArg(["--dir=  "], cwd)).toThrow(/needs a path/);
  });
  it("rejects the space-separated form", () => {
    expect(() => parseDirArg(["--dir", "data/sub"], cwd)).toThrow(/--dir=<path>/);
  });
  it("rejects the repo root and anything outside data/", () => {
    for (const v of [".", "tmp/out", "../elsewhere", "/etc", "data/..", "data/../src"]) {
      expect(() => parseDirArg([`--dir=${v}`], cwd), v).toThrow(/data\/ or a path inside it/);
    }
  });
  it("allows a directory whose name merely starts with two dots", () => {
    expect(parseDirArg(["--dir=data/..x"], cwd)).toBe("/repo/data/..x");
  });
  it("rejects the legacy --out flag, with or without a value", () => {
    expect(() => parseDirArg(["--out=data/facilities.json"], cwd)).toThrow(/use --dir/);
    expect(() => parseDirArg(["--out"], cwd)).toThrow(/use --dir/);
  });
});
