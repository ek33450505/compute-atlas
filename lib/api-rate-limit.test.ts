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
});
