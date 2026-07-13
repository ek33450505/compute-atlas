import { NextResponse } from "next/server";

/**
 * Permissive CORS headers for the public read API — no auth, no cookies,
 * safe to open to any origin since every route here is read-only.
 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
