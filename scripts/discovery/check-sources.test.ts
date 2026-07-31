import { describe, it, expect, vi } from "vitest";

import { checkSources, isBlockedHost, type SourceCheckDeps } from "./check-sources";
import type { Facility } from "../../lib/schema";

function makeFacility(overrides: Partial<Facility> = {}, urls: string[] = ["https://example.com/a"]): Facility {
  return {
    id: overrides.id ?? "facility-a",
    name: overrides.name ?? "Facility A",
    operator: "Acme Corp",
    status: "operational",
    facilityType: "data_center",
    confidence: "confirmed",
    location: { lat: 30.1, lon: -97.1, city: "Austin", state: "TX", precision: "exact" },
    statusHistory: [],
    sources: urls.map((url, i) => ({
      url,
      label: `Source ${i}`,
      retrievedAt: "2026-01-01",
      kind: "press" as const,
    })),
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

function makeFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; headers?: Record<string, string> }> | never,
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const result = await handler(url, init);
    return {
      ok: result.ok,
      status: result.status,
      headers: new Headers(result.headers ?? {}),
    } as Response;
  });
}

function baseDeps(overrides: Partial<SourceCheckDeps> = {}): SourceCheckDeps {
  return {
    fetchImpl: makeFetch(async () => ({ ok: true, status: 200 })),
    concurrency: 5,
    timeoutMs: 10000,
    sleepImpl: async () => {},
    ...overrides,
  };
}

describe("checkSources", () => {
  it("classifies a 2xx response as ok", async () => {
    const deps = baseDeps({ fetchImpl: makeFetch(async () => ({ ok: true, status: 200 })) });
    const results = await checkSources([makeFacility()], deps);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe("ok");
    expect(results[0].httpStatus).toBe(200);
    expect(results[0].facilityId).toBe("facility-a");
    expect(results[0].url).toBe("https://example.com/a");
    expect(typeof results[0].checkedAt).toBe("string");
  });

  it("classifies a 404 response as gone", async () => {
    const deps = baseDeps({ fetchImpl: makeFetch(async () => ({ ok: false, status: 404 })) });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("gone");
    expect(results[0].httpStatus).toBe(404);
  });

  it("classifies a 403 response as bot_blocked (not dead)", async () => {
    const deps = baseDeps({ fetchImpl: makeFetch(async () => ({ ok: false, status: 403 })) });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("bot_blocked");
    expect(results[0].httpStatus).toBe(403);
  });

  it("classifies a 400 response as client_error", async () => {
    const deps = baseDeps({ fetchImpl: makeFetch(async () => ({ ok: false, status: 400 })) });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("client_error");
    expect(results[0].httpStatus).toBe(400);
  });

  it("classifies a 500 response as server_error after retry exhaustion", async () => {
    const deps = baseDeps({ fetchImpl: makeFetch(async () => ({ ok: false, status: 500 })) });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("server_error");
    expect(results[0].httpStatus).toBe(500);
  });

  it("retries a 429 honoring Retry-After, then classifies throttled after exhaustion", async () => {
    let calls = 0;
    const fetchImpl = makeFetch(async () => {
      calls++;
      return { ok: false, status: 429, headers: { "retry-after": "1" } };
    });
    const sleeps: number[] = [];
    const deps = baseDeps({
      fetchImpl,
      maxRetries: 2,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("throttled");
    expect(results[0].httpStatus).toBe(429);
    expect(sleeps).toEqual([1000, 1000]);
    // 1 initial HEAD + 2 retries = 3 total attempts.
    expect(calls).toBe(3);
  });

  it("retries a 429 with no Retry-After header using exponential backoff", async () => {
    const fetchImpl = makeFetch(async () => ({ ok: false, status: 429 }));
    const sleeps: number[] = [];
    const deps = baseDeps({
      fetchImpl,
      maxRetries: 2,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("throttled");
    expect(sleeps).toEqual([500, 1000]);
  });

  it("classifies a 3xx response as redirected", async () => {
    const deps = baseDeps({ fetchImpl: makeFetch(async () => ({ ok: false, status: 301 })) });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("redirected");
    expect(results[0].httpStatus).toBe(301);
  });

  it("classifies an AbortError (timeout) as timeout with null status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      throw err;
    });
    const deps = baseDeps({ fetchImpl, timeoutMs: 1 });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("timeout");
    expect(results[0].httpStatus).toBeNull();
  });

  it("classifies a thrown non-abort error as error with null status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network unreachable");
    });
    const deps = baseDeps({ fetchImpl });
    const results = await checkSources([makeFacility()], deps);
    expect(results[0].classification).toBe("error");
    expect(results[0].httpStatus).toBeNull();
  });

  it("falls back to GET when HEAD is rejected", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === "HEAD") {
        return { ok: false, status: 405 } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });
    const deps = baseDeps({ fetchImpl });
    const results = await checkSources([makeFacility()], deps);
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(results[0].classification).toBe("ok");
    expect(results[0].httpStatus).toBe(200);
  });

  it("dispatches requests with a browser-like User-Agent header", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
    const deps = baseDeps({ fetchImpl });
    await checkSources([makeFacility()], deps);
    const [, init] = fetchImpl.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla/);
  });

  it("populates sourceIndex per source within a facility", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
    const facility = makeFacility({}, ["https://example.com/1", "https://example.com/2", "https://example.com/3"]);
    const deps = baseDeps({ fetchImpl });
    const results = await checkSources([facility], deps);
    expect(results.map((r) => r.sourceIndex)).toEqual([0, 1, 2]);
  });

  it("rejects non-http(s) URLs without dispatching fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
    const facility = makeFacility({}, ["ftp://example.com/file", "javascript:alert(1)"]);
    const deps = baseDeps({ fetchImpl });
    const results = await checkSources([facility], deps);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.classification).toBe("error");
      expect(r.httpStatus).toBeNull();
    }
  });

  it("checks every source URL across all facilities (full dataset)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
    const facilities = [
      makeFacility({ id: "f1", name: "F1" }, ["https://example.com/1", "https://example.com/2"]),
      makeFacility({ id: "f2", name: "F2" }, ["https://example.com/3"]),
    ];
    const deps = baseDeps({ fetchImpl });
    const results = await checkSources(facilities, deps);
    expect(results).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("respects bounded concurrency (never exceeds the configured limit in-flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200 } as Response;
    });
    const facilities = Array.from({ length: 10 }, (_, i) =>
      makeFacility({ id: `f${i}`, name: `F${i}` }, [`https://example.com/${i}`]),
    );
    const deps = baseDeps({ fetchImpl, concurrency: 3 });
    await checkSources(facilities, deps);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("never reads response bodies (Response mock exposes no body reader call)", async () => {
    let bodyAccessed = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return {
        ok: true,
        status: 200,
        get text() {
          bodyAccessed = true;
          return async () => "";
        },
      } as unknown as Response;
    });
    const deps = baseDeps({ fetchImpl });
    await checkSources([makeFacility()], deps);
    expect(bodyAccessed).toBe(false);
  });

  describe("SSRF guard (blocked hosts)", () => {
    const blockedUrls = [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.0.1/",
      "http://[::1]/",
      "http://localhost:8080/",
    ];

    it.each(blockedUrls)("classifies %s as blocked and never calls fetch", async (url) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
      const facility = makeFacility({ id: "f-blocked" }, [url]);
      const deps = baseDeps({ fetchImpl });
      const results = await checkSources([facility], deps);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe("blocked");
      expect(results[0].httpStatus).toBeNull();
      expect(results[0].url).toBe(url);
    });

    it("still probes a normal public URL (fetch is called, classified normally)", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
      const facility = makeFacility({ id: "f-normal" }, ["https://example.com/x"]);
      const deps = baseDeps({ fetchImpl });
      const results = await checkSources([facility], deps);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(results[0].classification).toBe("ok");
      expect(results[0].httpStatus).toBe(200);
    });

    it("blocks a mix of blocked and public URLs independently, calling fetch only for the public one", async () => {
      const calledUrls: string[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        calledUrls.push(typeof input === "string" ? input : input.toString());
        return { ok: true, status: 200 } as Response;
      });
      const facility = makeFacility({ id: "f-mixed" }, [
        "http://169.254.169.254/latest/meta-data/",
        "https://example.com/legit",
      ]);
      const deps = baseDeps({ fetchImpl });
      const results = await checkSources([facility], deps);

      expect(calledUrls).toEqual(["https://example.com/legit"]);
      const blocked = results.find((r) => r.url === "http://169.254.169.254/latest/meta-data/");
      const ok = results.find((r) => r.url === "https://example.com/legit");
      expect(blocked?.classification).toBe("blocked");
      expect(ok?.classification).toBe("ok");
    });

    it("isBlockedHost blocks the IPv4-mapped IPv6 cloud-metadata address in hex-hextet form", () => {
      // Node's WHATWG URL parser canonicalizes ::ffff:169.254.169.254 to
      // this hex-hextet form (::ffff:a9fe:a9fe) — this is the form
      // isBlockedHost actually sees in the real code path, not the
      // dotted-quad form.
      expect(isBlockedHost("::ffff:a9fe:a9fe")).toBe(true);
    });

    it("blocks a source URL whose IPv4-mapped IPv6 literal is the cloud-metadata IP, end-to-end through new URL() canonicalization", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
      const facility = makeFacility({ id: "f-mapped-metadata" }, ["http://[::ffff:169.254.169.254]/x"]);
      const deps = baseDeps({ fetchImpl });
      const results = await checkSources([facility], deps);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe("blocked");
      expect(results[0].httpStatus).toBeNull();
    });
  });
});
