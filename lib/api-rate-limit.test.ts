import { describe, it, expect, beforeEach } from "vitest";

import {
  checkApiRateLimit,
  tooManyRequests,
  __resetApiRateLimit,
  __bucketCount,
  API_RATE_LIMIT_MAX,
  API_RATE_LIMIT_WINDOW_MS,
  MAX_BUCKETS,
} from "@/lib/api-rate-limit";

describe("checkApiRateLimit", () => {
  beforeEach(() => {
    __resetApiRateLimit();
  });

  it("allows up to API_RATE_LIMIT_MAX requests within a window", () => {
    const ip = "1.2.3.4";
    const now = Date.now();
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect(checkApiRateLimit(ip, now).ok).toBe(true);
    }
  });

  it("blocks the request once the max is exceeded", () => {
    const ip = "1.2.3.4";
    const now = Date.now();
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      checkApiRateLimit(ip, now);
    }
    const result = checkApiRateLimit(ip, now);
    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("resets the window once API_RATE_LIMIT_WINDOW_MS has elapsed", () => {
    const ip = "1.2.3.4";
    const now = Date.now();
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      checkApiRateLimit(ip, now);
    }
    expect(checkApiRateLimit(ip, now).ok).toBe(false);

    const later = now + API_RATE_LIMIT_WINDOW_MS;
    expect(checkApiRateLimit(ip, later).ok).toBe(true);
  });

  it("tracks separate IPs independently", () => {
    const now = Date.now();
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      checkApiRateLimit("1.1.1.1", now);
    }
    expect(checkApiRateLimit("1.1.1.1", now).ok).toBe(false);
    expect(checkApiRateLimit("2.2.2.2", now).ok).toBe(true);
  });

  it("keeps the tracked bucket count at or below MAX_BUCKETS under a flood of distinct IPs", () => {
    const now = Date.now();
    const floodSize = MAX_BUCKETS + 50;
    for (let i = 0; i < floodSize; i++) {
      checkApiRateLimit(`10.0.0.${i}`, now);
    }
    expect(__bucketCount()).toBeLessThanOrEqual(MAX_BUCKETS);
  });
});

describe("tooManyRequests", () => {
  it("returns a 429 with the shared CORS headers and Retry-After", () => {
    const res = tooManyRequests(30);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("carries the origin only, and makes no preflight-only verb claim", () => {
    // Inverted on 2026-09-27, deliberately. This used to assert the full set,
    // which is how a 429 on a public read endpoint came to advertise
    // `Authorization` and four write verbs to any origin. Per the Fetch
    // standard those two headers are consulted during a CORS-preflight fetch
    // and nowhere else, so on this 429 they permitted nothing — they only
    // published a claim, and a false one for a rate-limit response. What a
    // caller may send is decided by the path's own `OPTIONS`
    // (`corsPreflight(scope)` in lib/api-response.ts); the origin is the only
    // CORS header that does work here, and it is still asserted above.
    const res = tooManyRequests(30);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("reflects the retryAfter it was passed", () => {
    expect(tooManyRequests(7).headers.get("Retry-After")).toBe("7");
    expect(tooManyRequests(60).headers.get("Retry-After")).toBe("60");
  });

  /**
   * A 429 must never be storable at the edge. A Cloudflare cache rule makes
   * every non-`/admin` GET cache-eligible, so an origin response with no cache
   * directive is given `public, max-age=14400` — one rate-limited caller's 429
   * would then be served to every other client of that URL for 4 hours. Both
   * header names are asserted because Cloudflare evaluates `CDN-Cache-Control`
   * ahead of `Cache-Control`, so either one alone leaves a mode uncovered.
   */
  it("is uncacheable at both the browser and the CDN layer", () => {
    const res = tooManyRequests(30);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("returns the documented error body", async () => {
    const res = tooManyRequests(30);
    await expect(res.json()).resolves.toEqual({ error: "Too many requests" });
  });
});
