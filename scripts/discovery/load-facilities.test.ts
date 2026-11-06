/**
 * Direct coverage for loadFacilities() — the Neon-first/JSON-fallback loader
 * shared by the discovery CLIs. The DB read, clock, sleep and cache dir are
 * all injected, so no test touches a real database or the real os.tmpdir().
 *
 * The file-fallback path (`process.cwd()`/data/facilities.json) stays
 * hardcoded; those tests compare against an independent read of the same file
 * and never assert a count or a specific record, since the dataset grows.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { Facility } from "../../lib/schema";
import { cacheFileNameFor, loadFacilities } from "./load-facilities";

// Cache reads re-validate with facilitiesSchema, so the DB fixture is a real record.
const DB_FACILITY = (readRealFacilitiesFile() as Facility[])[0];
const SECRET = "postgres://user:hunter2@host/db";

function readRealFacilitiesFile(): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), "data", "facilities.json"), "utf-8"));
}

const noSleep = async () => {};

function sleepRecorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

let cacheDir: string;
let errSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "load-facilities-test-"));
  vi.stubEnv("DATABASE_URL", FAKE_URL);
  vi.stubEnv("DISCOVERY_FACILITIES_CACHE_TTL_MS", "");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const stderrText = () => errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
const FAKE_URL = "postgres://fake";
const cacheFile = () => path.join(cacheDir, cacheFileNameFor(FAKE_URL));

describe("loadFacilities", () => {
  it("returns the DB's facilities with source: db, no dbError", async () => {
    const readDb = vi.fn(async () => [DB_FACILITY]);

    const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep });

    expect(result).toEqual({ facilities: [DB_FACILITY], source: "db", cached: false });
    expect(result.dbError).toBeUndefined();
    expect(stderrText()).toContain("facilities: 1 from db");
  });

  describe("bounded retry", () => {
    it("retries a thrown error and then returns the DB result", async () => {
      const rec = sleepRecorder();
      const readDb = vi
        .fn<() => Promise<Facility[]>>()
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValueOnce([DB_FACILITY]);

      const result = await loadFacilities({ readDb, cacheDir, sleep: rec.sleep });

      expect(result.source).toBe("db");
      expect(readDb).toHaveBeenCalledTimes(2);
      expect(rec.delays).toEqual([2_000]);
    });

    it("treats a 0-row result as a failure and retries", async () => {
      const readDb = vi
        .fn<() => Promise<Facility[]>>()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([DB_FACILITY]);

      const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep });

      expect(result.source).toBe("db");
      expect(result.facilities).toEqual([DB_FACILITY]);
      expect(readDb).toHaveBeenCalledTimes(2);
    });

    it("falls back to data/facilities.json after 3 failed attempts, warning without the raw error message", async () => {
      const rec = sleepRecorder();
      const readDb = vi.fn(async () => {
        throw new Error(`Failed query: select ... params: ${SECRET}`);
      });

      const result = await loadFacilities({ readDb, cacheDir, sleep: rec.sleep });

      expect(result.source).toBe("file");
      expect(readDb).toHaveBeenCalledTimes(3);
      expect(rec.delays).toEqual([2_000, 8_000]);
      expect(result.dbError).toContain("3 attempts");
      expect(result.facilities.length).toBeGreaterThan(0);
      expect(result.facilities).toEqual(readRealFacilitiesFile());
      const err = stderrText();
      expect(err).toContain("WARNING");
      expect(err).toContain("duplicate");
      expect(err).not.toContain("hunter2");
      expect(err).not.toContain("Failed query");
      expect(result.dbError).not.toContain("hunter2");
    });
  });

  it("times out a hung read, retries, then falls back with dbError naming the timeout", async () => {
    const readDb = vi.fn(() => new Promise<Facility[]>(() => {}));

    const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep, attemptTimeoutMs: 5 });

    expect(readDb).toHaveBeenCalledTimes(3);
    expect(result.source).toBe("file");
    expect(result.dbError).toBe("3 attempts; last: timeout");
  });

  it("with no DATABASE_URL falls back to the file with a warning and never calls readDb", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const readDb = vi.fn(async () => [DB_FACILITY]);

    const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep });

    expect(result.source).toBe("file");
    expect(readDb).not.toHaveBeenCalled();
    expect(result.facilities).toEqual(readRealFacilitiesFile());
    expect(stderrText()).toContain("DATABASE_URL is not set");
  });

  describe("snapshot cache", () => {
    it("serves a second call within the TTL from the cache without reading the DB", async () => {
      const readDb = vi.fn(async () => [DB_FACILITY]);
      let t = 1_000_000;
      const deps = { readDb, cacheDir, sleep: noSleep, now: () => t };

      await loadFacilities(deps);
      t += 60_000;
      const second = await loadFacilities(deps);

      expect(readDb).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ facilities: [DB_FACILITY], source: "db", cached: true });
      expect(stderrText()).toContain("(cached)");
    });

    it("re-reads the DB once the TTL has elapsed", async () => {
      const readDb = vi.fn(async () => [DB_FACILITY]);
      let t = 1_000_000;
      const deps = { readDb, cacheDir, sleep: noSleep, now: () => t };

      await loadFacilities(deps);
      t += 30 * 60_000;
      const second = await loadFacilities(deps);

      expect(readDb).toHaveBeenCalledTimes(2);
      expect(second.cached).toBe(false);
    });

    it("does not serve an expired cache when the DB read fails", async () => {
      let t = 1_000_000;
      await loadFacilities({ readDb: async () => [DB_FACILITY], cacheDir, sleep: noSleep, now: () => t });
      t += 31 * 60_000;
      const bad = vi.fn(async () => {
        throw new Error("down");
      });

      const result = await loadFacilities({ readDb: bad, cacheDir, sleep: noSleep, now: () => t });

      expect(result.source).toBe("file");
    });

    it("DISCOVERY_FACILITIES_CACHE_TTL_MS=0 disables the cache entirely", async () => {
      vi.stubEnv("DISCOVERY_FACILITIES_CACHE_TTL_MS", "0");
      const readDb = vi.fn(async () => [DB_FACILITY]);
      const deps = { readDb, cacheDir, sleep: noSleep };

      await loadFacilities(deps);
      await loadFacilities(deps);

      expect(readDb).toHaveBeenCalledTimes(2);
      expect(() => statSync(cacheFile())).toThrow();
    });

    it("an unparseable TTL uses the default and warns", async () => {
      vi.stubEnv("DISCOVERY_FACILITIES_CACHE_TTL_MS", "soon");
      const readDb = vi.fn(async () => [DB_FACILITY]);
      const deps = { readDb, cacheDir, sleep: noSleep };

      await loadFacilities(deps);
      const second = await loadFacilities(deps);

      expect(second.cached).toBe(true);
      expect(stderrText()).toContain("DISCOVERY_FACILITIES_CACHE_TTL_MS");
    });

    it("ignores a corrupt cache file and re-reads the DB", async () => {
      writeFileSync(cacheFile(), "{not json");
      const readDb = vi.fn(async () => [DB_FACILITY]);

      const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep });

      expect(readDb).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ facilities: [DB_FACILITY], source: "db", cached: false });
    });

    it("ignores a well-formed cache with the wrong shape", async () => {
      writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: "now", facilities: [DB_FACILITY] }));
      const readDb = vi.fn(async () => [DB_FACILITY]);

      await loadFacilities({ readDb, cacheDir, sleep: noSleep });

      expect(readDb).toHaveBeenCalledTimes(1);
    });

    it("ignores a cache whose payload fails facilitiesSchema", async () => {
      writeFileSync(
        cacheFile(),
        JSON.stringify({ fetchedAt: 1_000_000, facilities: [{ id: "bogus" }] }),
        { mode: 0o600 }
      );
      const readDb = vi.fn(async () => [DB_FACILITY]);

      const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep, now: () => 1_000_001 });

      expect(readDb).toHaveBeenCalledTimes(1);
      expect(result.cached).toBe(false);
    });

    it("refuses a cache file that is a symlink", async () => {
      const real = path.join(cacheDir, "real.json");
      writeFileSync(real, JSON.stringify({ fetchedAt: 1_000_000, facilities: [DB_FACILITY] }), { mode: 0o600 });
      symlinkSync(real, cacheFile());
      const readDb = vi.fn(async () => [DB_FACILITY]);

      const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep, now: () => 1_000_001 });

      expect(readDb).toHaveBeenCalledTimes(1);
      expect(result.cached).toBe(false);
    });

    it("refuses a cache file with group/other permission bits", async () => {
      writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: 1_000_000, facilities: [DB_FACILITY] }), { mode: 0o600 });
      chmodSync(cacheFile(), 0o644);
      const readDb = vi.fn(async () => [DB_FACILITY]);

      const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep, now: () => 1_000_001 });

      expect(readDb).toHaveBeenCalledTimes(1);
      expect(result.cached).toBe(false);
    });

    it("keys the cache file to the database host + name, never the credentials", async () => {
      const a = cacheFileNameFor("postgres://u:secret1@host-a/db1?sslmode=require");
      expect(a).toBe(cacheFileNameFor("postgres://other:secret2@host-a/db1"));
      expect(a).not.toBe(cacheFileNameFor("postgres://u:secret1@host-b/db1"));
      expect(a).not.toBe(cacheFileNameFor("postgres://u:secret1@host-a/db2"));
      expect(a).not.toContain("secret");

      await loadFacilities({ readDb: async () => [DB_FACILITY], cacheDir, sleep: noSleep });
      vi.stubEnv("DATABASE_URL", "postgres://fake-other/otherdb");
      const readDb = vi.fn(async () => [DB_FACILITY]);
      const result = await loadFacilities({ readDb, cacheDir, sleep: noSleep });

      expect(readDb).toHaveBeenCalledTimes(1);
      expect(result.cached).toBe(false);
    });

    it("tightens a group/other-readable cache dir to 0o700", async () => {
      chmodSync(cacheDir, 0o755);

      await loadFacilities({ readDb: async () => [DB_FACILITY], cacheDir, sleep: noSleep });

      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    });

    it("leaves no tmp file behind after a write", async () => {
      await loadFacilities({ readDb: async () => [DB_FACILITY], cacheDir, sleep: noSleep });

      expect(readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    it("writes the cache file with mode 0o600", async () => {
      await loadFacilities({ readDb: async () => [DB_FACILITY], cacheDir, sleep: noSleep });

      expect(statSync(cacheFile()).mode & 0o777).toBe(0o600);
    });
  });
});
