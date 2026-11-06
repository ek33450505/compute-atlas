import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET, POST } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";
import facilitiesRaw from "@/data/facilities.json";

const ADMIN_TOKEN = "test-admin-token";

function req(query: string, headers?: HeadersInit): Request {
  return new Request(`http://localhost/api/facilities${query}`, { headers });
}

function adminReq(query: string): Request {
  return req(query, { Authorization: `Bearer ${ADMIN_TOKEN}` });
}

function postReq(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/facilities", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// Every test request below hits the same "unknown" IP bucket (no
// x-forwarded-for header) — reset per-test so accumulated hits from one
// test's assertions never bleed into the next.
beforeEach(() => {
  __resetApiRateLimit();
});

describe("GET /api/facilities (anonymous: bulk access paused)", () => {
  const ORIGINAL = process.env.API_ADMIN_TOKEN;

  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.API_ADMIN_TOKEN;
    else process.env.API_ADMIN_TOKEN = ORIGINAL;
  });

  it("403s an anonymous request, no-store, with no facilities key", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.json();
    expect(body).not.toHaveProperty("facilities");
    expect(body.error).toContain("paused");
    expect(body.error).toContain("/facilities/<id>");
    expect(body.contact).toBe("https://www.compute-atlas.com/contact");
  });

  it("403s a wrong token", async () => {
    const res = await GET(req("", { Authorization: "Bearer nope" }));
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("facilities");
  });

  it("403s everyone when API_ADMIN_TOKEN is unset (fails closed)", async () => {
    delete process.env.API_ADMIN_TOKEN;
    const res = await GET(req("", { Authorization: "Bearer " }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/facilities (admin)", () => {
  const ORIGINAL = process.env.API_ADMIN_TOKEN;

  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.API_ADMIN_TOKEN;
    else process.env.API_ADMIN_TOKEN = ORIGINAL;
  });

  it("returns 200 no-store with facilities for the admin bearer", async () => {
    const res = await GET(adminReq(""));
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).not.toContain("public");
    expect(res.headers.get("CDN-Cache-Control")).toContain("no-store");
    const body = await res.json();
    expect(body.facilities.length).toBe(body.count);
  });

  it("returns the full dataset with no filters", async () => {
    const res = await GET(adminReq(""));
    const body = await res.json();
    expect(body.count).toBe(facilitiesRaw.length);
    expect(body.facilities.length).toBe(body.count);
  });

  it("carries the shared CORS header", async () => {
    const res = await GET(adminReq(""));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("narrows by ?status=operational", async () => {
    const res = await GET(adminReq("?status=operational"));
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThan(facilitiesRaw.length);
    expect(
      body.facilities.every((f: { status: string }) => f.status === "operational")
    ).toBe(true);
  });

  it("narrows by ?type=power_generation", async () => {
    const res = await GET(adminReq("?type=power_generation"));
    const body = await res.json();
    expect(body.count).toBe(
      facilitiesRaw.filter((f: { facilityType: string }) => f.facilityType === "power_generation")
        .length
    );
  });

  it("accepts comma-separated values for a single param", async () => {
    const res = await GET(adminReq("?status=operational,cancelled"));
    const body = await res.json();
    const single = await (
      await GET(adminReq("?status=operational"))
    ).json();
    const cancelledOnly = await (await GET(adminReq("?status=cancelled"))).json();
    expect(body.count).toBe(single.count + cancelledOnly.count);
  });

  it("accepts repeated params for the same key", async () => {
    const res = await GET(adminReq("?status=operational&status=cancelled"));
    const body = await res.json();
    const single = await (
      await GET(adminReq("?status=operational"))
    ).json();
    const cancelledOnly = await (await GET(adminReq("?status=cancelled"))).json();
    expect(body.count).toBe(single.count + cancelledOnly.count);
  });

  it("drops invalid status tokens instead of erroring, degrading to no constraint", async () => {
    const res = await GET(adminReq("?status=bogus"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // "bogus" is not a valid STATUS_ORDER member, so it's filtered out of the
    // statuses array; an empty statuses array means no status constraint —
    // the full dataset is returned, not zero results.
    expect(body.count).toBe(facilitiesRaw.length);
  });

  it("narrows by ?q= substring", async () => {
    const res = await GET(adminReq("?q=aws"));
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThan(facilitiesRaw.length);
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      const ok = await GET(adminReq(""));
      expect(ok.status).toBe(200);
    }
    const blocked = await GET(adminReq(""));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("POST /api/facilities", () => {
  const ORIGINAL = process.env.API_ADMIN_TOKEN;

  beforeEach(() => {
    delete process.env.API_ADMIN_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.API_ADMIN_TOKEN;
    } else {
      process.env.API_ADMIN_TOKEN = ORIGINAL;
    }
  });

  it("rejects a request with no admin token", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body before ever touching the DB", async () => {
    // Validation runs before the DB dup-check, so an invalid body 400s
    // without requiring DATABASE_URL to be set — if this test threw
    // "DATABASE_URL is not set", the handler's ordering would be wrong.
    process.env.API_ADMIN_TOKEN = "secret-token";
    const res = await POST(postReq({}, { Authorization: "Bearer secret-token" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid facility");
  });
});
