// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOOKUP_CACHE_MAX_ENTRIES,
  LOOKUP_CACHE_TTL_MS,
  SSRF_BLOCKED_CODE,
  __seedLookupCacheForTests,
  createGuardedLookup,
  createRateGate,
  resolveVetted,
  resolvesToBlockedAddress,
  type ResolveDeps,
} from "./net-guard";

const PUBLIC4 = "93.184.216.34";

function stub(answer: () => Promise<string[]> = async () => [PUBLIC4]) {
  return {
    resolve4: vi.fn(async () => answer()),
    resolve6: vi.fn(async (): Promise<string[]> => {
      throw Object.assign(new Error("no AAAA"), { code: "ENODATA" });
    }),
  };
}

function runLookup(deps: ResolveDeps, hostname: string) {
  return new Promise<{ err: Error | null; address?: unknown }>((resolve) => {
    createGuardedLookup(deps)(hostname, {}, (err, address) => resolve({ err, address }));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("vetted-address cache", () => {
  it("serves a second resolution from cache (no extra resolve4/resolve6)", async () => {
    const deps = stub();
    await resolveVetted("a.test", deps);
    const second = await resolveVetted("a.test", deps);
    expect(second).toMatchObject({ addresses: [PUBLIC4], blocked: false });
    expect(deps.resolve4).toHaveBeenCalledTimes(1);
    expect(deps.resolve6).toHaveBeenCalledTimes(1);
  });

  it("shares one resolution between the pre-check and the connect-time lookup", async () => {
    const deps = stub();
    expect(await resolvesToBlockedAddress("a.test", deps)).toBe(false);
    const { err, address } = await runLookup(deps, "a.test");
    expect(err).toBeNull();
    expect(address).toBe(PUBLIC4);
    expect(deps.resolve4).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight resolution between concurrent callers", async () => {
    const deps = stub();
    await Promise.all([resolveVetted("a.test", deps), resolveVetted("a.test", deps), resolveVetted("a.test", deps)]);
    expect(deps.resolve4).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after the TTL expires", async () => {
    vi.useFakeTimers();
    const deps = stub();
    await resolveVetted("a.test", deps);
    vi.advanceTimersByTime(LOOKUP_CACHE_TTL_MS - 1);
    await resolveVetted("a.test", deps);
    expect(deps.resolve4).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await resolveVetted("a.test", deps);
    expect(deps.resolve4).toHaveBeenCalledTimes(2);
  });

  it("re-vets a cached address on every hit: a cached blocked address is refused, never served", async () => {
    const deps = stub();
    __seedLookupCacheForTests(deps, "poisoned.test", ["127.0.0.1"]);
    expect(await resolveVetted("poisoned.test", deps)).toMatchObject({ blocked: true, addresses: [] });
    expect(deps.resolve4).not.toHaveBeenCalled();

    __seedLookupCacheForTests(deps, "poisoned.test", ["10.0.0.5"]);
    const { err } = await runLookup(deps, "poisoned.test");
    expect((err as { code?: string }).code).toBe(SSRF_BLOCKED_CODE);
  });

  it("does not cache a partial result when one family failed with a RESOLVER failure", async () => {
    const deps = {
      resolve4: vi.fn(async () => [PUBLIC4]),
      resolve6: vi.fn(async (): Promise<string[]> => {
        throw Object.assign(new Error("refused"), { code: "EREFUSED" });
      }),
    };
    const first = await resolveVetted("a.test", deps);
    expect(first.addresses).toEqual([PUBLIC4]); // still usable for this call
    await resolveVetted("a.test", deps);
    expect(deps.resolve4).toHaveBeenCalledTimes(2);
  });

  it("DOES cache when the other family is ENODATA (no AAAA is normal)", async () => {
    const deps = stub(); // resolve6 rejects ENODATA
    await resolveVetted("a.test", deps);
    await resolveVetted("a.test", deps);
    expect(deps.resolve4).toHaveBeenCalledTimes(1);
  });

  it("never caches a blocked result", async () => {
    const deps = stub(async () => ["127.0.0.1"]);
    expect((await resolveVetted("evil.test", deps)).blocked).toBe(true);
    expect((await resolveVetted("evil.test", deps)).blocked).toBe(true);
    expect(deps.resolve4).toHaveBeenCalledTimes(2);
  });

  it("does not cache errors or empty results", async () => {
    let n = 0;
    const deps = stub(async () => {
      if (++n === 1) throw Object.assign(new Error("refused"), { code: "EREFUSED" });
      return [PUBLIC4];
    });
    const first = await resolveVetted("a.test", deps);
    expect(first.addresses).toEqual([]);
    expect((first.v4Error as { code?: string }).code).toBe("EREFUSED");
    expect((await resolveVetted("a.test", deps)).addresses).toEqual([PUBLIC4]);
    expect(deps.resolve4).toHaveBeenCalledTimes(2);
  });

  it("within the TTL a flipped authoritative answer is not seen: the connect goes to the vetted address", async () => {
    let answer = PUBLIC4;
    const deps = stub(async () => [answer]);
    await resolveVetted("a.test", deps);
    answer = "127.0.0.1"; // rebind inside the TTL: the documented residual window
    const { err, address } = await runLookup(deps, "a.test");
    expect(err).toBeNull();
    expect(address).toBe(PUBLIC4);
    expect(deps.resolve4).toHaveBeenCalledTimes(1);
  });

  it("evicts the least-recently-used entry past the size cap", async () => {
    const deps = stub();
    for (let i = 0; i <= LOOKUP_CACHE_MAX_ENTRIES; i++) await resolveVetted(`h${i}.test`, deps);
    const before = deps.resolve4.mock.calls.length;
    await resolveVetted(`h${LOOKUP_CACHE_MAX_ENTRIES}.test`, deps); // newest: hit
    expect(deps.resolve4.mock.calls.length).toBe(before);
    await resolveVetted("h0.test", deps); // oldest: evicted
    expect(deps.resolve4.mock.calls.length).toBe(before + 1);
  });

  it("awaits beforeResolve only for uncached resolutions", async () => {
    const beforeResolve = vi.fn(async () => {});
    const deps = { ...stub(), beforeResolve };
    await resolveVetted("a.test", deps);
    await resolveVetted("a.test", deps);
    expect(beforeResolve).toHaveBeenCalledTimes(1);
  });
});

describe("createRateGate", () => {
  it("uses the injected clock, not performance.now", async () => {
    vi.useFakeTimers();
    let t = 0;
    const gate = createRateGate(1, () => t);
    let passed = 0;
    void gate().then(() => passed++);
    void gate().then(() => passed++);
    await vi.advanceTimersByTimeAsync(0);
    expect(passed).toBe(1);
    t = 1000; // injected clock moves; the wait is computed from it
    await vi.advanceTimersByTimeAsync(1000);
    expect(passed).toBe(2);
  });

  it("lets the first call through and spaces the rest at 1/perSecond", async () => {
    vi.useFakeTimers();
    const gate = createRateGate(5); // 200 ms apart
    let passed = 0;
    for (let i = 0; i < 3; i++) void gate().then(() => passed++);
    await vi.advanceTimersByTimeAsync(0);
    expect(passed).toBe(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(passed).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(passed).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(passed).toBe(3);
  });
});
