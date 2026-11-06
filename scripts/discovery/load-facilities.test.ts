/**
 * Direct coverage for loadFacilities() — the API-first/JSON-fallback loader
 * shared by all five discovery CLIs (submit-candidates.ts, check-sources.ts,
 * existing-facilities.ts, extract-fields.ts, verify-fields.ts). Added
 * because none of those five scripts' own test suites exercise this
 * function: they all test their pure, injectable core logic with a
 * facilities array passed in directly, and never call main() — the loader's
 * only caller in every one of them.
 *
 * `fetchImpl` gets a real DI seam (this task's other change, in
 * load-facilities.ts) because that's the only injection point the house
 * pattern (fetch-page-text.ts's FetchPageTextDeps.fetchImpl) offers for a
 * bare global. The file-fallback path (`process.cwd()`/data/facilities.json)
 * stays hardcoded — no DI seam was added for it (out of scope; "minimal"
 * addition per the task). `vi.mock("node:fs", ...)` was tried first to point
 * that read at a fixture instead, but empirically does NOT intercept the
 * leaf's call in this Vite/Vitest 4.1.9 + jsdom setup — both fallback tests
 * silently read the real ~1,350-record data/facilities.json regardless of
 * the mock. No other file in this repo mocks node:fs, so there's no local
 * precedent to lean on either. Per the task's explicit fallback option, the
 * two fallback tests below assert against the REAL file's parse instead —
 * content-independent (never a hardcoded count or record), since the
 * dataset grows continuously and a size/content assertion here would be
 * exactly the brittle "hardcoded test-count" trap called out as a standing
 * risk. The invariant under test is "the fallback reads and JSON.parses
 * exactly this file," proven by comparing against an independent real read
 * of the same file done inside the test itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { Facility } from "../../lib/schema";
import { loadFacilities } from "./load-facilities";

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "acme-dc-1",
    name: "Acme Data Center 1",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 30.2672, lon: -97.7431, state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [{ url: "https://example.com/acme", label: "Announcement", retrievedAt: "2026-01-01", kind: "press" }],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

const API_FACILITY = makeFacility({ id: "api-facility", name: "From The API" });

/** Independent read of the real fallback file, for comparison — never a
 * hardcoded count or specific record, since data/facilities.json grows
 * continuously. */
function readRealFacilitiesFile(): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), "data", "facilities.json"), "utf-8"));
}

const noSleep = async () => {};

function sleepRecorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

const okResponse = () =>
  ({ ok: true, status: 200, json: async () => ({ facilities: [API_FACILITY] }) }) as Response;
const statusResponse = (status: number) => ({ ok: false, status, statusText: "" }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.API_ADMIN_TOKEN;
});

describe("loadFacilities", () => {
  it("returns the API's facilities when fetch succeeds, source: api, no apiError", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({
      ok: true,
      json: async () => ({ facilities: [API_FACILITY] }),
    }) as Response);

    const result = await loadFacilities("http://localhost:3000", fetchImpl);

    expect(result).toEqual({ facilities: [API_FACILITY], source: "api" });
    expect(result.apiError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:3000/api/facilities", expect.anything());
  });

  it("falls back to reading data/facilities.json when fetch rejects (network error), and reports the thrown message", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });

    const result = await loadFacilities("http://localhost:3000", fetchImpl, { sleep: noSleep });

    expect(result.source).toBe("file");
    expect(result.apiError).toBe("3 attempts; last: network down");
    expect(Array.isArray(result.facilities)).toBe(true);
    expect(result.facilities.length).toBeGreaterThan(0);
    expect(result.facilities).toEqual(readRealFacilitiesFile());
  });

  // This is the case the pre-fix code discarded entirely: the non-ok branch
  // fell through to the file fallback with no record of the status at all.
  it("falls back to reading data/facilities.json when the API responds non-OK, and names the status in apiError", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }) as Response
    );

    const result = await loadFacilities("http://localhost:3000", fetchImpl, { sleep: noSleep });

    expect(result.source).toBe("file");
    expect(result.apiError).toContain("503");
    expect(result.apiError).toContain("Service Unavailable");
    expect(Array.isArray(result.facilities)).toBe(true);
    expect(result.facilities.length).toBeGreaterThan(0);
    expect(result.facilities).toEqual(readRealFacilitiesFile());
  });

  it("uses the global fetch when fetchImpl is omitted, matching every existing call site", async () => {
    const globalFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ facilities: [API_FACILITY] }),
    }));
    vi.stubGlobal("fetch", globalFetch);

    const result = await loadFacilities("http://localhost:3000");

    expect(result).toEqual({ facilities: [API_FACILITY], source: "api" });
    expect(globalFetch).toHaveBeenCalledWith("http://localhost:3000/api/facilities", expect.anything());
  });

  describe("bounded retry", () => {
    it("retries a thrown error once and then returns the API result", async () => {
      const rec = sleepRecorder();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(okResponse());

      const result = await loadFacilities("http://x", fetchImpl, { sleep: rec.sleep });

      expect(result).toEqual({ facilities: [API_FACILITY], source: "api" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(rec.delays).toEqual([2_000]);
    });

    it("gives up after 3 attempts on an HTML 200 body and reports the attempt count", async () => {
      const rec = sleepRecorder();
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => JSON.parse("<!DOCTYPE html><html></html>"),
          }) as Response
      );

      const result = await loadFacilities("http://x", fetchImpl, { sleep: rec.sleep });

      expect(result.source).toBe("file");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(result.apiError).toContain("3 attempts");
      expect(result.apiError).not.toContain("\n");
      expect(rec.delays).toEqual([2_000, 8_000]);
    });

    it("retries a 503 and then succeeds", async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(statusResponse(503))
        .mockResolvedValueOnce(okResponse());

      const result = await loadFacilities("http://x", fetchImpl, { sleep: noSleep });

      expect(result.source).toBe("api");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does not retry a 403; falls back after exactly one call", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => statusResponse(403));

      const result = await loadFacilities("http://x", fetchImpl, { sleep: noSleep });

      expect(result.source).toBe("file");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.apiError).toContain("403");
    });

    it("retries a 429 and then succeeds", async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(statusResponse(429))
        .mockResolvedValueOnce(okResponse());

      const result = await loadFacilities("http://x", fetchImpl, { sleep: noSleep });

      expect(result.source).toBe("api");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("treats a 200 body without a facilities array as retryable", async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response)
        .mockResolvedValueOnce(okResponse());

      const result = await loadFacilities("http://x", fetchImpl, { sleep: noSleep });

      expect(result).toEqual({ facilities: [API_FACILITY], source: "api" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("passes an AbortSignal to every fetch", async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(okResponse());

      await loadFacilities("http://x", fetchImpl, { sleep: noSleep });

      for (const call of fetchImpl.mock.calls) {
        expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});

describe("loadFacilities admin bearer", () => {
  it("sends Authorization: Bearer when API_ADMIN_TOKEN is set", async () => {
    process.env.API_ADMIN_TOKEN = "tok-123";
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    await loadFacilities("http://localhost:3000", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/facilities",
      expect.objectContaining({ headers: { Authorization: "Bearer tok-123" } })
    );
  });

  it("sends no Authorization header when API_ADMIN_TOKEN is unset", async () => {
    delete process.env.API_ADMIN_TOKEN;
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    await loadFacilities("http://localhost:3000", fetchImpl);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });

  it("403 falls back to the file immediately and warns on stderr naming the token", async () => {
    delete process.env.API_ADMIN_TOKEN;
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => statusResponse(403));
    const result = await loadFacilities("http://localhost:3000", fetchImpl, { sleep: noSleep });
    expect(result.source).toBe("file");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/API_ADMIN_TOKEN missing/);
  });

  it("401 with a token set warns that the token is invalid", async () => {
    process.env.API_ADMIN_TOKEN = "stale";
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => statusResponse(401));
    await loadFacilities("http://localhost:3000", fetchImpl, { sleep: noSleep });
    expect(String(warn.mock.calls[0][0])).toMatch(/API_ADMIN_TOKEN was sent but rejected \(invalid\)/);
  });

  it("does not warn on a 404 fallback", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => statusResponse(404));
    await loadFacilities("http://localhost:3000", fetchImpl, { sleep: noSleep });
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends the bearer to https and to http localhost / 127.0.0.1", async () => {
    process.env.API_ADMIN_TOKEN = "tok-123";
    for (const base of ["https://www.compute-atlas.com", "http://localhost:3000", "http://127.0.0.1:3000"]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
      await loadFacilities(base, fetchImpl);
      const init = fetchImpl.mock.calls[0][1] as RequestInit;
      expect(init.headers, base).toEqual({ Authorization: "Bearer tok-123" });
    }
  });

  it("withholds the bearer from plain http to a remote host and warns once on stderr", async () => {
    vi.resetModules();
    const { loadFacilities: fresh } = await import("./load-facilities");
    process.env.API_ADMIN_TOKEN = "tok-123";
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    await fresh("http://example.com", fetchImpl);
    await fresh("http://example.com", fetchImpl);
    for (const call of fetchImpl.mock.calls) {
      expect((call[1] as RequestInit).headers).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/neither https nor localhost/);
  });

  it("403 on a withheld-token base URL says withheld, not invalid", async () => {
    process.env.API_ADMIN_TOKEN = "tok-123";
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => statusResponse(403));
    await loadFacilities("http://example.org", fetchImpl, { sleep: noSleep });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /API_ADMIN_TOKEN withheld: base URL is not https or loopback/.test(m))).toBe(true);
    expect(messages.some((m) => /rejected \(invalid\)/.test(m))).toBe(false);
  });

  it("withholds the bearer from a hostname that merely starts with localhost", async () => {
    process.env.API_ADMIN_TOKEN = "tok-123";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    await loadFacilities("http://localhost.evil.com", fetchImpl);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toBeUndefined();
  });
});
