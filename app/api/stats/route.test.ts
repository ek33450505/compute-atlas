import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";
import facilitiesRaw from "@/data/facilities.json";
import meta from "@/data/facilities.meta.json";

function req(): Request {
  return new Request("http://localhost/api/stats");
}

beforeEach(() => {
  __resetApiRateLimit();
});

describe("GET /api/stats", () => {
  it("returns the aggregate stats shape", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      count: expect.any(Number),
      states: expect.any(Number),
      operationalMw: expect.any(Number),
      plannedMw: expect.any(Number),
      underConstructionMw: expect.any(Number),
    });
    expect(body.count).toBe(facilitiesRaw.length);
  });

  it("includes the dataset edition's version/asOf/schemaVersion, matching facilities.meta.json", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(body.edition).toEqual({
      version: meta.sourceRelease,
      asOf: meta.asOf,
      schemaVersion: meta.schemaVersion,
    });
  });

  it("never presents two conflicting record counts: edition omits recordCount so it can't clash with the live count", async () => {
    const res = await GET(req());
    const body = await res.json();
    // `count` (top-level, live) and `meta.recordCount` (the last published
    // snapshot) are free to be genuinely different numbers — that's the
    // real-world condition that made the old payload misleading. The
    // invariant isn't that they match; it's that the response never states
    // a second, unlabeled record count under `edition`.
    expect(body.count).toEqual(expect.any(Number));
    expect(body.edition).not.toHaveProperty("recordCount");
  });

  it("rounds summed capacity fields to 1 decimal place", async () => {
    const res = await GET(req());
    const body = await res.json();
    for (const value of [body.operationalMw, body.plannedMw, body.underConstructionMw]) {
      expect(Math.round(value * 10) / 10).toBe(value);
    }
  });

  it("carries the shared CORS header", async () => {
    const res = await GET(req());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("carries a public Cache-Control header", async () => {
    const res = await GET(req());
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=");
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      const ok = await GET(req());
      expect(ok.status).toBe(200);
    }
    const blocked = await GET(req());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});
