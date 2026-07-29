import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET, POST } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";
import facilitiesRaw from "@/data/facilities.json";

function req(query: string): Request {
  return new Request(`http://localhost/api/facilities${query}`);
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

describe("GET /api/facilities", () => {
  it("returns the full dataset with no filters", async () => {
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.count).toBe(facilitiesRaw.length);
    expect(body.facilities.length).toBe(body.count);
  });

  it("carries the shared CORS header", async () => {
    const res = await GET(req(""));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("narrows by ?status=operational", async () => {
    const res = await GET(req("?status=operational"));
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThan(facilitiesRaw.length);
    expect(
      body.facilities.every((f: { status: string }) => f.status === "operational")
    ).toBe(true);
  });

  it("narrows by ?type=power_generation", async () => {
    const res = await GET(req("?type=power_generation"));
    const body = await res.json();
    expect(body.count).toBe(
      facilitiesRaw.filter((f: { facilityType: string }) => f.facilityType === "power_generation")
        .length
    );
  });

  it("accepts comma-separated values for a single param", async () => {
    const res = await GET(req("?status=operational,cancelled"));
    const body = await res.json();
    const single = await (
      await GET(req("?status=operational"))
    ).json();
    const cancelledOnly = await (await GET(req("?status=cancelled"))).json();
    expect(body.count).toBe(single.count + cancelledOnly.count);
  });

  it("accepts repeated params for the same key", async () => {
    const res = await GET(req("?status=operational&status=cancelled"));
    const body = await res.json();
    const single = await (
      await GET(req("?status=operational"))
    ).json();
    const cancelledOnly = await (await GET(req("?status=cancelled"))).json();
    expect(body.count).toBe(single.count + cancelledOnly.count);
  });

  it("drops invalid status tokens instead of erroring, degrading to no constraint", async () => {
    const res = await GET(req("?status=bogus"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // "bogus" is not a valid STATUS_ORDER member, so it's filtered out of the
    // statuses array; an empty statuses array means no status constraint —
    // the full dataset is returned, not zero results.
    expect(body.count).toBe(facilitiesRaw.length);
  });

  it("narrows by ?q= substring", async () => {
    const res = await GET(req("?q=aws"));
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThan(facilitiesRaw.length);
  });

  it("carries a public Cache-Control header", async () => {
    const res = await GET(req(""));
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=");
    expect(cacheControl).toContain("stale-while-revalidate=");
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      const ok = await GET(req(""));
      expect(ok.status).toBe(200);
    }
    const blocked = await GET(req(""));
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
