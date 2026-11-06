import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

const ADMIN_TOKEN = "test-admin-token";
const KNOWN_ID = "talen-susquehanna-aws-pa";

function get(id: string, token?: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/facilities/${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    params(id)
  );
}

describe("GET /api/facilities/[id] (admin-only)", () => {
  const ORIGINAL = process.env.API_ADMIN_TOKEN;
  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = ADMIN_TOKEN;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.API_ADMIN_TOKEN;
    else process.env.API_ADMIN_TOKEN = ORIGINAL;
  });

  it("returns 403 no-store with no record fields to an anonymous caller for a known id", async () => {
    const res = await get(KNOWN_ID);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.json();
    expect(body.id).toBeUndefined();
    expect(body.name).toBeUndefined();
  });

  it("returns the identical 403 for a non-existent id (no existence oracle)", async () => {
    const known = await get(KNOWN_ID);
    const missing = await get("not-a-real-facility");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual(await known.json());
  });

  it("still requires the bearer when the request path is uppercase (/API/...)", async () => {
    const anon = await GET(new Request(`http://localhost/API/facilities/${KNOWN_ID}`), params(KNOWN_ID));
    expect(anon.status).toBe(403);
    const ok = await GET(
      new Request(`http://localhost/API/facilities/${KNOWN_ID}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      params(KNOWN_ID)
    );
    expect(ok.status).toBe(200);
  });

  it("returns 403 for a wrong token", async () => {
    const res = await get(KNOWN_ID, "wrong-token");
    expect(res.status).toBe(403);
  });

  it("returns 403 when no admin token is configured", async () => {
    delete process.env.API_ADMIN_TOKEN;
    const res = await get(KNOWN_ID, ADMIN_TOKEN);
    expect(res.status).toBe(403);
  });

  it("returns 200 no-store with the facility for the admin token", async () => {
    const res = await get(KNOWN_ID, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).not.toContain("public");
    expect((await res.json()).id).toBe(KNOWN_ID);
  });

  it("returns 404 for an unknown id when authorized", async () => {
    const id = "not-a-real-facility";
    const res = await get(id, ADMIN_TOKEN);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.id).toBe(id);
  });

  it("applies the rate gate before auth (429 even for an anonymous caller)", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      const denied = await get(KNOWN_ID);
      expect(denied.status).toBe(403);
    }
    const blocked = await get(KNOWN_ID);
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
