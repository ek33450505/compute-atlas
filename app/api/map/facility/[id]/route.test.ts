import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, OPTIONS } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";
import * as data from "@/lib/data";
import * as dailyLimit from "@/lib/api-daily-limit";
import sitingRaw from "@/data/siting-context.json";

const sitingById = sitingRaw as Record<string, { nearestWater?: { name: string } }>;
const KNOWN_ID = "talen-susquehanna-aws-pa";
const WATER_ID = Object.keys(sitingById).find((id) => sitingById[id].nearestWater)!;

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/map/facility/${id}`), params(id));
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

beforeEach(() => {
  __resetApiRateLimit();
  vi.restoreAllMocks();
});

describe("GET /api/map/facility/[id]", () => {
  it("returns a popup summary carrying no coordinates anywhere", async () => {
    const res = await get(KNOWN_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: KNOWN_ID, name: expect.any(String), state: expect.any(String) });
    const keys = keysDeep(body);
    for (const banned of ["location", "lat", "lon", "lng", "latitude", "longitude", "coordinates", "point", "geometry"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("includes nearestWater when the siting context has it", async () => {
    const res = await get(WATER_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nearestWater?.name).toBe(sitingById[WATER_ID].nearestWater!.name);
  });

  it("serves the cacheable header on success", async () => {
    const res = await get(KNOWN_ID);
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("s-maxage=3600");
    expect(cc).toContain("stale-while-revalidate=86400");
    expect(cc).not.toContain("no-store");
  });

  it("returns a no-store 404 for an unknown id without echoing it", async () => {
    const res = await get("no-such-facility-zz");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(JSON.stringify(await res.json())).not.toContain("no-such-facility-zz");
  });

  it.each(["Bad_ID", "-leading-dash", "has space", "a".repeat(201), "x%2Fy"])(
    "returns 404 for malformed id %j without calling the loader",
    async (id) => {
      const spy = vi.spyOn(data, "getFacilityByIdCached");
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    }
  );

  it("rejects a malformed id before the daily gate (no DB round trip)", async () => {
    const daily = vi.spyOn(dailyLimit, "checkDailyApiGate");
    expect((await get("Bad_ID")).status).toBe(404);
    expect(daily).not.toHaveBeenCalled();
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await get(KNOWN_ID)).status).toBe(200);
    }
    const blocked = await get(KNOWN_ID);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("answers OPTIONS preflight with a read-scope 204", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    const allow = res.headers.get("Access-Control-Allow-Methods");
    expect(allow).toBeTruthy();
    expect(allow).not.toMatch(/POST|PATCH|DELETE/);
  });
});
