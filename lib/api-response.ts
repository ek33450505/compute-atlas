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
