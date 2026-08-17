import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Facility } from "@/lib/schema";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";

// vi.mock calls are hoisted above imports by Vitest — mirrors the hoisted-mock
// convention in lib/search-db.test.ts / submission-detail.test.tsx.
// `searchFacilitiesDb` returns `[]` in Vitest (no DATABASE_URL), so the
// underlying search layer is mocked to exercise the route's response shape.
// Spreads the REAL module via `importOriginal` so `MAX_SEARCH_QUERY_LEN`
// stays the actual exported constant instead of a hardcoded test double.
const { searchFacilitiesDbMock } = vi.hoisted(() => ({
  searchFacilitiesDbMock: vi.fn(),
}));

vi.mock("@/lib/search-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-db")>();
  return {
    ...actual,
    searchFacilitiesDb: searchFacilitiesDbMock,
  };
});

import { GET } from "./route";
import { MAX_SEARCH_QUERY_LEN } from "@/lib/search-db";
import type { FacilitySearchResult } from "@/lib/search-db";

function req(query: string): Request {
  return new Request(`http://localhost/api/search${query}`);
}

const FIXTURE_FACILITIES: Facility[] = [
  { id: "facility-a", name: "Facility A" } as Facility,
  { id: "facility-b", name: "Facility B" } as Facility,
];

/** A healthy `searchFacilitiesDb` result — a real answer, safe to cache. */
function ok(facilities: Facility[]): FacilitySearchResult {
  return { facilities, degraded: false };
}

/** A DB-failure result: the same empty body, but not a real answer. */
const DEGRADED: FacilitySearchResult = { facilities: [], degraded: true };

describe("GET /api/search", () => {
  beforeEach(() => {
    searchFacilitiesDbMock.mockReset();
    // Every test request below hits the same "unknown" IP bucket (no
    // x-forwarded-for header) — reset per-test so accumulated hits from one
    // test's assertions never bleed into the next.
    __resetApiRateLimit();
  });

  it("returns matching facilities for a non-empty query", async () => {
    searchFacilitiesDbMock.mockResolvedValue(ok(FIXTURE_FACILITIES));

    const res = await GET(req("?q=hyperscale"));
    const body = await res.json();

    expect(body.count).toBe(2);
    expect(body.facilities.length).toBe(2);
    expect(body.query).toBe("hyperscale");
  });

  it("carries the shared CORS header", async () => {
    searchFacilitiesDbMock.mockResolvedValue(ok([]));

    const res = await GET(req("?q=hyperscale"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns an empty result set for an empty query", async () => {
    searchFacilitiesDbMock.mockResolvedValue(ok([]));

    const res = await GET(req("?q="));
    const body = await res.json();

    expect(body.count).toBe(0);
    expect(body.facilities).toEqual([]);
  });

  it("passes the q param through to searchFacilitiesDb", async () => {
    searchFacilitiesDbMock.mockResolvedValue(ok([]));

    await GET(req("?q=hyperscale"));

    expect(searchFacilitiesDbMock).toHaveBeenCalledWith("hyperscale");
  });

  it("carries a public Cache-Control header", async () => {
    searchFacilitiesDbMock.mockResolvedValue(ok([]));

    const res = await GET(req("?q=hyperscale"));
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=");
  });

  it("does not let a degraded empty result carry CDN cache headers", async () => {
    // The bug this guards: a 2-second Neon blip returns `[]`, the route sends
    // it through `cacheableJson`, and Vercel's edge then serves
    // "No matches for google" for 600s fresh + 3600s stale-while-revalidate —
    // long after the DB recovered. With the bug reintroduced this fails with
    // `expected 'public, s-maxage=600, stale-while-revalidate=3600' not to
    // contain 's-maxage'`.
    searchFacilitiesDbMock.mockResolvedValue(DEGRADED);

    const res = await GET(req("?q=google"));
    const cacheControl = res.headers.get("Cache-Control");

    expect(cacheControl).not.toContain("s-maxage");
    expect(cacheControl).not.toContain("stale-while-revalidate");
    expect(cacheControl).toBe("no-store");
  });

  it("still answers 200 with the usual body shape when degraded", async () => {
    // Degrading must stay invisible as an *error* on the public endpoint —
    // only its cacheability changes.
    searchFacilitiesDbMock.mockResolvedValue(DEGRADED);

    const res = await GET(req("?q=google"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(body).toEqual({ count: 0, facilities: [], query: "google" });
  });

  it("still caches a genuine empty result set (no matches is a real answer)", async () => {
    // The other half of the invariant: the fix must not turn every empty
    // response into an uncached one, or a flood of no-match queries would
    // reach the DB on every request.
    searchFacilitiesDbMock.mockResolvedValue(ok([]));

    const res = await GET(req("?q=zzzznomatch"));
    const cacheControl = res.headers.get("Cache-Control");

    expect(cacheControl).toContain("s-maxage=600");
    expect(cacheControl).toContain("stale-while-revalidate=3600");
  });

  it("truncates a long q to MAX_SEARCH_QUERY_LEN in the echoed query field", async () => {
    searchFacilitiesDbMock.mockResolvedValue(ok([]));

    const longQuery = "a".repeat(MAX_SEARCH_QUERY_LEN + 50);
    const res = await GET(req(`?q=${longQuery}`));
    const body = await res.json();

    expect(body.query.length).toBe(MAX_SEARCH_QUERY_LEN);
    expect(body.query).toBe(longQuery.slice(0, MAX_SEARCH_QUERY_LEN));
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    searchFacilitiesDbMock.mockResolvedValue(ok([]));

    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      const ok = await GET(req("?q=hyperscale"));
      expect(ok.status).toBe(200);
    }
    const blocked = await GET(req("?q=hyperscale"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});
