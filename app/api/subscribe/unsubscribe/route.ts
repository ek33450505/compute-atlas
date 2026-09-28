import { NextResponse } from "next/server";

import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { corsPreflight, NO_STORE_HEADERS } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { unsubscribeByToken } from "@/lib/subscribe";

/**
 * Prefix for this route's own `checkApiRateLimit` buckets — separate from the
 * public read API's bare-IP keys and from the sibling token routes, so a burst
 * against one surface cannot starve another (same reasoning as
 * `checkIntakeRateLimit("contact")` vs `("leads")` in lib/rate-limit.ts, whose
 * separation is the `surface` predicate on every read). GET
 * and POST share this prefix: they are one surface doing one thing, and the
 * work they cost is identical.
 */
const RATE_BUCKET_PREFIX = "sub-unsub:";

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get("token") ?? "";
}

/**
 * Browser-navigated unsubscribe link. Redirects same-origin to a hardcoded
 * status page path — never derived from user input, so there is no
 * open-redirect surface here.
 *
 * UNCACHEABLE (measured on prod 2026-09-27): a Cloudflare cache rule makes
 * every non-`/admin` GET cache-eligible, and with no origin directive
 * Cloudflare supplied `public, max-age=14400` — caching an unsubscribe token
 * in a cache key, and the outcome of using it, for 4 hours.
 *
 * RATE LIMITED with the in-memory burst limiter, deliberately not a DB-backed
 * one: this route costs a Neon SELECT plus an UPDATE per call, so a DB-backed
 * counter would add the very queries the limit exists to prevent.
 */
export async function GET(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  const { status } = await unsubscribeByToken(tokenFrom(request));

  const path = status === "invalid" ? "/subscribe/invalid" : "/subscribe/unsubscribed";
  return NextResponse.redirect(new URL(path, request.url), { headers: NO_STORE_HEADERS });
}

/**
 * RFC 8058 one-click unsubscribe: mail clients POST here (no redirect
 * follow) in response to the `List-Unsubscribe`/`List-Unsubscribe-Post`
 * headers set in lib/email.ts. Plain 200, no body.
 *
 * Carries the same `no-store` pair as the GET. A POST is not cache-eligible
 * under Cloudflare's rule in the first place, so this is belt-and-braces
 * rather than a measured fix — but the response is per-token and must never be
 * stored by anything, including an intermediary that ignores method.
 */
export async function POST(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  await unsubscribeByToken(tokenFrom(request));
  return new Response(null, { status: 200, headers: NO_STORE_HEADERS });
}

// `public-write`: GET and POST, both authorised by a token in the URL rather
// than a header — so `Authorization` is advertised to nobody, and there is no
// PATCH/DELETE to advertise either.
export function OPTIONS() {
  return corsPreflight("public-write");
}
