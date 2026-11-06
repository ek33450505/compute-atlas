import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, OPTIONS, MAX_OPERATORS, MAX_OPERATOR_LENGTH } from "./route";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";
import * as data from "@/lib/data";
import * as dailyLimit from "@/lib/api-daily-limit";
import { CAPACITY_OPTIONS } from "@/lib/capacity-options";
import { getFacilityMaxMw } from "@/lib/format";
import type { Facility } from "@/lib/schema";

const loc = { lat: 30, lon: -97, state: "TX" };
const base = { status: "operational", confidence: "high", sources: [], lastUpdated: "2026-01-01" };
const FIXTURES = [
  { ...base, id: "a-big", name: "A", operator: "Acme", facilityType: "data_center", location: loc, capacityMw: { operational: 500 } },
  { ...base, id: "a-small", name: "B", operator: "Acme", facilityType: "data_center", location: loc, capacityMw: { operational: 10 } },
  { ...base, id: "z-big", name: "C", operator: "Zed, Inc.", facilityType: "data_center", location: loc, capacityMw: { operational: 300 } },
  { ...base, id: "z-none", name: "D", operator: "Zed, Inc.", facilityType: "data_center", location: loc },
] as unknown as Facility[];

function get(qs: string, headers?: HeadersInit): Promise<Response> {
  return GET(new Request(`http://localhost/api/map/match${qs}`, { headers }));
}

beforeEach(() => {
  __resetApiRateLimit();
  vi.restoreAllMocks();
  vi.spyOn(data, "getAllFacilities").mockResolvedValue(FIXTURES);
});

describe("GET /api/map/match", () => {
  it("fixture sanity: capacity helper sees the fixtures", () => {
    expect(getFacilityMaxMw(FIXTURES[0])).toBe(500);
  });

  it("matches by operator, including names containing commas", async () => {
    const res = await get("?operator=Acme&operator=Zed%2C%20Inc.");
    expect(res.status).toBe(200);
    expect((await res.json()).ids.sort()).toEqual(["a-big", "a-small", "z-big", "z-none"]);
    const one = await get("?operator=Zed%2C%20Inc.");
    expect((await one.json()).ids.sort()).toEqual(["z-big", "z-none"]);
  });

  it("matches by minMw, excluding facilities with no capacity", async () => {
    const res = await get("?minMw=100");
    expect((await res.json()).ids.sort()).toEqual(["a-big", "z-big"]);
  });

  it("intersects operator and minMw", async () => {
    const res = await get("?operator=Acme&minMw=100");
    expect((await res.json()).ids).toEqual(["a-big"]);
  });

  it("body carries only `ids`", async () => {
    const body = await (await get("?minMw=100")).json();
    expect(Object.keys(body)).toEqual(["ids"]);
  });

  it("serves the cacheable header on success", async () => {
    const cc = (await get("?minMw=100")).headers.get("Cache-Control") ?? "";
    expect(cc).toContain("s-maxage=3600");
    expect(cc).toContain("stale-while-revalidate=86400");
    expect(cc).not.toContain("no-store");
  });

  it.each([
    ["no filters", ""],
    ["minMw=0 alone", "?minMw=0"],
    ["unknown params only", "?q=acme"],
    ["negative minMw", "?minMw=-5"],
    ["minMw not in the popover (250)", "?minMw=250&operator=Acme"],
    ["zero-padded minMw", "?minMw=0100"],
    ["plus-signed minMw", "?minMw=%2B100"],
    ["exponent minMw", "?minMw=1e2"],
    ["minMw=0 with an operator", "?minMw=0&operator=Acme"],
    ["unknown key alongside a valid filter", "?operator=Acme&q=acme"],
    ["unknown key (limit)", "?minMw=100&limit=5"],
    ["fractional minMw", "?minMw=1.5"],
    ["non-numeric minMw", "?minMw=abc"],
    ["repeated minMw", "?minMw=100&minMw=500"],
    ["empty operator", "?operator="],
    ["too many operators", "?" + Array.from({ length: MAX_OPERATORS + 1 }, (_, i) => `operator=o${i}`).join("&")],
    ["operator too long", `?operator=${"x".repeat(MAX_OPERATOR_LENGTH + 1)}`],
  ])("returns a no-store 400 for %s without loading data", async (_label, qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(await res.json()).toEqual({ error: "Bad request" });
    expect(data.getAllFacilities).not.toHaveBeenCalled();
  });

  it("accepts every non-zero popover capacity value", async () => {
    for (const o of CAPACITY_OPTIONS.filter((c) => c.value !== "0")) {
      expect((await get(`?minMw=${o.value}`)).status).toBe(200);
    }
  });

  it("de-duplicates operators before applying the cap", async () => {
    const qs = "?" + Array.from({ length: MAX_OPERATORS + 10 }, () => "operator=Acme").join("&");
    const res = await get(qs);
    expect(res.status).toBe(200);
    expect((await res.json()).ids.sort()).toEqual(["a-big", "a-small"]);
  });

  it("returns 429 when the daily gate refuses, before loading data", async () => {
    vi.spyOn(dailyLimit, "checkDailyApiGate").mockResolvedValue({ ok: false, retryAfter: 42 } as never);
    const res = await get("?minMw=100");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(data.getAllFacilities).not.toHaveBeenCalled();
  });

  it("rejects a malformed query before the daily gate", async () => {
    const daily = vi.spyOn(dailyLimit, "checkDailyApiGate");
    expect((await get("?minMw=250")).status).toBe(400);
    expect(daily).not.toHaveBeenCalled();
  });

  it("accepts exactly the operator cap", async () => {
    const qs = "?" + Array.from({ length: MAX_OPERATORS }, (_, i) => `operator=o${i}`).join("&");
    expect((await get(qs)).status).toBe(200);
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await get("?minMw=100")).status).toBe(200);
    }
    const blocked = await get("?minMw=100");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("answers OPTIONS preflight with a read-scope 204", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).not.toMatch(/POST|PATCH|DELETE/);
  });
});
