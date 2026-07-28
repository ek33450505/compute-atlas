import { describe, it, expect, beforeEach } from "vitest";
import { GET, PATCH, DELETE } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function req(id: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost/api/facilities/${id}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Every test request below hits the same "unknown" IP bucket (no
// x-forwarded-for header) — reset per-test so accumulated hits from one
// test's assertions never bleed into the next.
beforeEach(() => {
  __resetApiRateLimit();
});

describe("GET /api/facilities/[id]", () => {
  it("returns 200 with the matching facility for a known id", async () => {
    const id = "talen-susquehanna-aws-pa";
    const res = await GET(new Request(`http://localhost/api/facilities/${id}`), params(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const facility = await res.json();
    expect(facility.id).toBe(id);
  });

  it("returns 404 with an error for an unknown id", async () => {
    const id = "not-a-real-facility";
    const res = await GET(new Request(`http://localhost/api/facilities/${id}`), params(id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.id).toBe(id);
  });

  it("carries a public Cache-Control header on a hit", async () => {
    const id = "talen-susquehanna-aws-pa";
    const res = await GET(new Request(`http://localhost/api/facilities/${id}`), params(id));
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=");
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    const id = "talen-susquehanna-aws-pa";
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      const ok = await GET(new Request(`http://localhost/api/facilities/${id}`), params(id));
      expect(ok.status).toBe(200);
    }
    const blocked = await GET(new Request(`http://localhost/api/facilities/${id}`), params(id));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("PATCH /api/facilities/[id]", () => {
  it("rejects a request with no admin token", async () => {
    const id = "talen-susquehanna-aws-pa";
    const res = await PATCH(req(id, "PATCH", { name: "New Name" }), params(id));
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/facilities/[id]", () => {
  it("rejects a request with no admin token", async () => {
    const id = "talen-susquehanna-aws-pa";
    const res = await DELETE(req(id, "DELETE"), params(id));
    expect(res.status).toBe(401);
  });
});
