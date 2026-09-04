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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadFacilities", () => {
  it("returns the API's facilities when fetch succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({
      ok: true,
      json: async () => ({ facilities: [API_FACILITY] }),
    }) as Response);

    const result = await loadFacilities("http://localhost:3000", fetchImpl);

    expect(result).toEqual([API_FACILITY]);
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:3000/api/facilities");
  });

  it("falls back to reading data/facilities.json when fetch rejects (network error)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });

    const result = await loadFacilities("http://localhost:3000", fetchImpl);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(readRealFacilitiesFile());
  });

  it("falls back to reading data/facilities.json when the API responds non-OK", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: false, status: 500 }) as Response);

    const result = await loadFacilities("http://localhost:3000", fetchImpl);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(readRealFacilitiesFile());
  });

  it("uses the global fetch when fetchImpl is omitted, matching every existing call site", async () => {
    const globalFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ facilities: [API_FACILITY] }),
    }));
    vi.stubGlobal("fetch", globalFetch);

    const result = await loadFacilities("http://localhost:3000");

    expect(result).toEqual([API_FACILITY]);
    expect(globalFetch).toHaveBeenCalledWith("http://localhost:3000/api/facilities");
  });
});
