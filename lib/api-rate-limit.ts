import { NextResponse } from "next/server";

import { CORS_HEADERS } from "@/lib/api-response";

/**
 * In-memory fixed-window rate limiter for the public read API (the GET
 * facilities/search/stats/schema endpoints). This is a per-instance,
 * best-effort abuse backstop, NOT a hard global cap: bucket state resets on
 * cold start and is not shared across serverless instances/regions. The real
 * load-bearing defense against sustained load is the CDN caching in
 * `cacheableJson` (`lib/api-response.ts`) — most repeat traffic never reaches
 * this code at all, since it's served from cache. This limiter just bounds
 * how much work one warm instance will do for one IP inside a short burst.
 *
 * Deliberately separate from `lib/rate-limit.ts`'s DB-backed
 * `checkRateLimit`/`checkSubscribeRateLimit` — those guard write surfaces and
 * cost a query per check; a DB hit per read request here would defeat the
 * caching goal this limiter exists to protect.
 */
export const API_RATE_LIMIT_MAX = 60;
export const API_RATE_LIMIT_WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Hard ceiling on distinct concurrent IP buckets — the sole bound, enforced
 * entirely by FIFO eviction in `checkApiRateLimit` below (there is no
 * separate prune pass): once `buckets` is at capacity, a brand-new IP evicts
 * the oldest-inserted bucket (a `Map` preserves insertion order) before
 * being inserted, so `buckets.size` can never exceed `MAX_BUCKETS`.
 * Otherwise an attacker varying `X-Forwarded-For` within a single window
 * could grow this Map without bound. A legitimate early-inserted caller can
 * be evicted under such a flood — their counter simply resets (fail-open) —
 * which is acceptable for a best-effort limiter whose real defense against
 * sustained load is the CDN cache in front of it.
 */
export const MAX_BUCKETS = 10_000;

/**
 * Fixed-window check for `ip`: a request within `API_RATE_LIMIT_WINDOW_MS` of
 * the window's start increments its counter; once the window has elapsed the
 * counter resets. Accepts `now` as a parameter (defaulting to `Date.now()`)
 * so tests can advance time deterministically instead of faking timers.
 *
 * The FIFO eviction below only applies on the brand-new-IP insertion path
 * (`!existing`) — resetting an already-tracked IP's expired window never
 * evicts anything, it just overwrites that IP's own bucket in place.
 */
export function checkApiRateLimit(
  ip: string,
  now: number = Date.now()
): { ok: boolean; retryAfter: number } {
  const existing = buckets.get(ip);
  if (!existing || now - existing.windowStart >= API_RATE_LIMIT_WINDOW_MS) {
    if (!existing && buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(ip, { count: 1, windowStart: now });
    return { ok: true, retryAfter: 0 };
  }

  existing.count++;
  if (existing.count <= API_RATE_LIMIT_MAX) {
    return { ok: true, retryAfter: 0 };
  }

  const retryAfter = Math.ceil((existing.windowStart + API_RATE_LIMIT_WINDOW_MS - now) / 1000);
  return { ok: false, retryAfter };
}

/** 429 response for a caller over the limit. Not cacheable — CORS + `Retry-After` only. */
export function tooManyRequests(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "Too many requests" },
    { status: 429, headers: { ...CORS_HEADERS, "Retry-After": String(retryAfter) } }
  );
}

/** Test-only: clears all bucket state between test cases. */
export function __resetApiRateLimit(): void {
  buckets.clear();
}

/** Test-only: current number of tracked IP buckets, to verify the hard FIFO ceiling holds. */
export function __bucketCount(): number {
  return buckets.size;
}
