// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RESOLVER_OUTAGE_THRESHOLD,
  ResolverOutageError,
  TIMEOUT_OUTAGE_THRESHOLD,
  checkSources,
  runLane,
  type SourceCheckDeps,
} from "./check-sources";
import * as netGuard from "./net-guard";
import { createGuardedLookup, type ResolveDeps } from "./net-guard";
import type { Facility } from "../../lib/schema";

function facilities(n: number): Facility[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    name: `F${i}`,
    sources: [{ url: `https://host${i}.test/a`, label: "s", retrievedAt: "2026-01-01", kind: "press" }],
  })) as unknown as Facility[];
}

const failWith = (code: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("lookup failed"), { code }) });

function deps(fetchImpl: typeof fetch, overrides: Partial<SourceCheckDeps> = {}): SourceCheckDeps {
  return {
    fetchImpl,
    concurrency: 1,
    timeoutMs: 60_000,
    sleepImpl: async () => {},
    lookupsPerSecond: 1000,
    outageThreshold: 3,
    resolveDeps: { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] },
    ...overrides,
  };
}

const refusing = (code: string) => ({
  resolve4: vi.fn(async (): Promise<string[]> => {
    throw Object.assign(new Error("lookup failed"), { code });
  }),
  resolve6: vi.fn(async (): Promise<string[]> => {
    throw Object.assign(new Error("lookup failed"), { code });
  }),
});

const neverFetch = () =>
  vi.fn<typeof fetch>(async () => {
    throw new Error("must not fetch");
  });

/** A fetch that connects through the real guarded lookup, like undici does,
 * wrapping the lookup error as `fetch failed` with a `cause`. */
function lookupFetch(resolveDeps: ResolveDeps) {
  const lookup = createGuardedLookup(resolveDeps);
  return vi.fn<typeof fetch>(
    (input) =>
      new Promise<Response>((_resolve, reject) => {
        lookup(new URL(String(input)).hostname, {}, (err) =>
          reject(new TypeError("fetch failed", { cause: err ?? new Error("unexpected") })),
        );
      }),
  );
}

describe("resolver-outage circuit breaker", () => {
  it("trips after N consecutive lookup-level refusals and stops scheduling", async () => {
    const resolveDeps = refusing("EREFUSED");
    const fetchImpl = neverFetch();
    const err = await checkSources(facilities(20), deps(fetchImpl, { resolveDeps })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolverOutageError);
    expect((err as ResolverOutageError).code).toBe("EREFUSED");
    expect(resolveDeps.resolve4).toHaveBeenCalledTimes(3);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EAI_AGAIN", "ECANCELLED"])("counts a lookup-level %s", async (code) => {
    await expect(checkSources(facilities(10), deps(neverFetch(), { resolveDeps: refusing(code) }))).rejects.toBeInstanceOf(
      ResolverOutageError,
    );
  });

  it("trips when A=ENODATA and AAAA=EREFUSED (the refusal is not masked by a per-host code)", async () => {
    const resolveDeps: ResolveDeps = {
      resolve4: async () => {
        throw Object.assign(new Error("no data"), { code: "ENODATA" });
      },
      resolve6: async () => {
        throw Object.assign(new Error("refused"), { code: "EREFUSED" });
      },
    };
    const err = await checkSources(facilities(40), deps(neverFetch(), { outageThreshold: undefined, resolveDeps })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ResolverOutageError);
    expect((err as ResolverOutageError).code).toBe("EREFUSED");
    expect((err as ResolverOutageError).consecutive).toBe(RESOLVER_OUTAGE_THRESHOLD);
  });

  it("does NOT trip when both families answer ENODATA/ENOTFOUND", async () => {
    const fail = (code: string) => async (): Promise<string[]> => {
      throw Object.assign(new Error("x"), { code });
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw failWith("ENOTFOUND");
    });
    const results = await checkSources(
      facilities(30),
      deps(fetchImpl, { outageThreshold: 25, resolveDeps: { resolve4: fail("ENODATA"), resolve6: fail("ENOTFOUND") } }),
    );
    expect(results).toHaveLength(30);
  });

  it("trips on a refusal raised at connect time (through the guarded lookup)", async () => {
    // First resolution per host: A ok, AAAA refused (not cached, so the connect resolves again); then A refuses.
    const seen = new Set<string>();
    const resolveDeps: ResolveDeps = {
      resolve4: async (h) => {
        if (!seen.has(h)) {
          seen.add(h);
          return ["93.184.216.34"];
        }
        throw Object.assign(new Error("refused"), { code: "EREFUSED" });
      },
      resolve6: async () => {
        throw Object.assign(new Error("refused"), { code: "EREFUSED" });
      },
    };
    const err = await checkSources(facilities(10), deps(lookupFetch(resolveDeps), { resolveDeps })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolverOutageError);
  });

  it("does NOT trip on socket-level ECONNREFUSED to the source host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw failWith("ECONNREFUSED");
    });
    const results = await checkSources(facilities(30), deps(fetchImpl, { outageThreshold: 25 }));
    expect(results).toHaveLength(30);
    expect(results[0]).toMatchObject({ classification: "error", errorCode: "ECONNREFUSED" });
  });

  it("DOES trip on 25 lookup-level refusals at the default threshold", async () => {
    const err = await checkSources(facilities(40), deps(neverFetch(), { outageThreshold: undefined, resolveDeps: refusing("EREFUSED") })).catch(
      (e: unknown) => e,
    );
    expect((err as ResolverOutageError).consecutive).toBe(RESOLVER_OUTAGE_THRESHOLD);
  });

  it("does NOT trip on ENOTFOUND (a per-host fact, i.e. link rot)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw failWith("ENOTFOUND");
    });
    const results = await checkSources(facilities(10), deps(fetchImpl));
    expect(results).toHaveLength(10);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it("a successful probe resets the streak", async () => {
    let n = 0;
    const resolveDeps: ResolveDeps = {
      resolve4: async () => {
        // two refusals, then a success, repeatedly: never 3 in a row
        if (n++ % 3 === 2) return ["93.184.216.34"];
        throw Object.assign(new Error("refused"), { code: "EREFUSED" });
      },
      resolve6: async () => [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ status: 200, headers: new Headers() }) as Response);
    const results = await checkSources(facilities(12), deps(fetchImpl, { resolveDeps }));
    expect(results).toHaveLength(12);
  });

  it("records the error code on an `error` result and only there", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("host0")) throw failWith("ENOTFOUND");
      return { status: 200, headers: new Headers() } as Response;
    });
    const [bad, good] = await checkSources(facilities(2), deps(fetchImpl));
    expect(bad).toMatchObject({ classification: "error", errorCode: "ENOTFOUND" });
    expect(good.classification).toBe("ok");
    expect("errorCode" in good).toBe(false);
  });
});

describe("silent-drop (timeout) breaker", () => {
  const abortingFetch = () =>
    vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

  it("trips after N consecutive probe timeouts", async () => {
    const fetchImpl = abortingFetch();
    const err = await checkSources(facilities(20), deps(fetchImpl, { timeoutThreshold: 4 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolverOutageError);
    expect((err as ResolverOutageError).kind).toBe("timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("60 consecutive timeouts on ONE host do NOT trip; 50 distinct hosts DO", async () => {
    const oneHost = Array.from({ length: 60 }, (_, i) => ({
      id: `f${i}`,
      name: `F${i}`,
      sources: [{ url: `https://dead.test/p${i}`, label: "s", retrievedAt: "2026-01-01", kind: "press" }],
    })) as unknown as Facility[];
    const results = await checkSources(oneHost, deps(abortingFetch(), { timeoutThreshold: undefined }));
    expect(results).toHaveLength(60);
    const err = await checkSources(facilities(80), deps(abortingFetch(), { timeoutThreshold: undefined })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolverOutageError);
    expect((err as ResolverOutageError).consecutive).toBe(TIMEOUT_OUTAGE_THRESHOLD);
  });

  it("a blocked result resets both streaks", async () => {
    // Pattern per 3 hosts: 2 resolver refusals then 1 blocked (loopback). With threshold 3 it never trips.
    let n = 0;
    const resolveDeps: ResolveDeps = {
      resolve4: async () => {
        if (n++ % 3 === 2) return ["127.0.0.1"];
        throw Object.assign(new Error("refused"), { code: "EREFUSED" });
      },
      resolve6: async () => [],
    };
    const results = await checkSources(facilities(12), deps(neverFetch(), { resolveDeps }));
    expect(results.filter((r) => r.classification === "blocked")).toHaveLength(4);

    // Timeout streak: 2 timeouts, then a blocked host, repeated; threshold 3 never trips.
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    let m = 0;
    const mixed: ResolveDeps = { resolve4: async () => (m++ % 3 === 2 ? ["127.0.0.1"] : ["93.184.216.34"]), resolve6: async () => [] };
    const r2 = await checkSources(facilities(12), deps(fetchImpl, { resolveDeps: mixed, timeoutThreshold: 3 }));
    expect(r2).toHaveLength(12);
  });

  it("a non-timeout outcome resets the timeout streak", async () => {
    let n = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (n++ % 4 === 3) return { status: 200, headers: new Headers() } as Response;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const results = await checkSources(facilities(16), deps(fetchImpl, { timeoutThreshold: 4 }));
    expect(results).toHaveLength(16);
  });

  it("exports a default threshold", () => {
    expect(TIMEOUT_OUTAGE_THRESHOLD).toBe(50);
  });
});

describe("agent lifecycle", () => {
  it("closes the lane's pinned Agent on a trip and on success", async () => {
    // fetchImpl injected => no Agent is built; the closable path is covered via net-guard.
    const close = vi.fn(async () => {});
    const spy = vi.spyOn(netGuard, "createClosablePinnedFetch").mockReturnValue({
      fetch: vi.fn<typeof fetch>(async () => ({ status: 200, headers: new Headers() }) as Response),
      close,
    });
    try {
      await checkSources(facilities(2), { ...deps(undefined as never), fetchImpl: undefined });
      expect(close).toHaveBeenCalledTimes(1);
      const failing = refusing("EREFUSED");
      await expect(
        checkSources(facilities(10), { ...deps(undefined as never, { resolveDeps: failing }), fetchImpl: undefined }),
      ).rejects.toBeInstanceOf(ResolverOutageError);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("runLane", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "check-sources-"));
    prev = process.env.DISCOVERY_LOG_DIR;
    process.env.DISCOVERY_LOG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DISCOVERY_LOG_DIR;
    else process.env.DISCOVERY_LOG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("on a trip writes no report, exits non-zero, and names the code only", async () => {
    expect(await runLane(facilities(10), deps(neverFetch(), { resolveDeps: refusing("EREFUSED") }))).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    const line = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(line).toContain("EREFUSED");
    expect(line).not.toContain("host");
    expect(line).not.toContain("lookup failed"); // err.message must never be logged
  });

  it("writes a report and exits 0 on a healthy run", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ status: 200, headers: new Headers() }) as Response);
    expect(await runLane(facilities(2), deps(fetchImpl))).toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("lookup rate cap", () => {
  afterEach(() => vi.useRealTimers());

  it("starts at most lookupsPerSecond new resolutions per second", async () => {
    vi.useFakeTimers();
    const resolve4 = vi.fn(async () => ["93.184.216.34"]);
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ status: 200, headers: new Headers() }) as Response);
    const done = checkSources(
      facilities(4),
      deps(fetchImpl, { concurrency: 4, lookupsPerSecond: 1, nowImpl: () => Date.now(), resolveDeps: { resolve4, resolve6: async () => [] } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve4).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolve4).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolve4).toHaveBeenCalledTimes(4);
    await done;
  });
});
