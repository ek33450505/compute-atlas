import { NextResponse } from "next/server";

/**
 * Permissive CORS headers for the facilities API. Reads are public; writes
 * (POST/PATCH/DELETE) authenticate via an `Authorization: Bearer` header,
 * never cookies — so `*` origin stays safe: browsers don't auto-attach bearer
 * tokens cross-origin, and `*` forbids credentialed requests, leaving no
 * CSRF / ambient-credential path.
 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const;

/** JSON response helper that always carries the shared CORS headers. */
export function jsonResponse(
  data: unknown,
  init?: ResponseInit
): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { ...CORS_HEADERS, ...init?.headers },
  });
}

/** Shared OPTIONS preflight response — each route re-exports this as its own `OPTIONS`. */
export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Bumped only on a breaking response-shape change to a public read endpoint. */
export const API_VERSION = "1";

/** CDN cache lifetime + stale-while-revalidate window, in seconds, for `cacheableJson`. */
export interface ReadCacheWindow {
  sMaxage: number;
  swr: number;
}

/** Per-endpoint cache tunables, one entry per public read GET. */
export const READ_CACHE = {
  list: { sMaxage: 3600, swr: 86400 },
  stats: { sMaxage: 3600, swr: 86400 },
  schema: { sMaxage: 86400, swr: 604800 },
  search: { sMaxage: 600, swr: 3600 },
  facility: { sMaxage: 3600, swr: 86400 },
} satisfies Record<string, ReadCacheWindow>;

/**
 * JSON response helper for cacheable public read endpoints: carries the
 * shared CORS headers plus a CDN-facing `Cache-Control`, the CC-BY-4.0 data
 * license/attribution headers, and the API version. Writes, error bodies,
 * and 429s stay on plain `jsonResponse` — never cached.
 */
export function cacheableJson(
  data: unknown,
  cache: ReadCacheWindow,
  init?: ResponseInit
): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": `public, s-maxage=${cache.sMaxage}, stale-while-revalidate=${cache.swr}`,
      "X-License": "CC-BY-4.0",
      Link: '<https://creativecommons.org/licenses/by/4.0/>; rel="license"',
      "X-API-Version": API_VERSION,
      ...init?.headers,
    },
  });
}
