import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";

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
    expect(body.count).toBe(310);
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
