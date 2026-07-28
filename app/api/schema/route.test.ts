import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";

function req(): Request {
  return new Request("http://localhost/api/schema");
}

beforeEach(() => {
  __resetApiRateLimit();
});

describe("GET /api/schema", () => {
  it("returns a JSON-Schema-shaped object without throwing", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    const looksLikeJsonSchema =
      "type" in body || "properties" in body || "$schema" in body || "anyOf" in body;
    expect(looksLikeJsonSchema).toBe(true);
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
