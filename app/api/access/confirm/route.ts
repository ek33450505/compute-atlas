import { NextResponse } from "next/server";

import { confirmAccessGrant } from "@/lib/access-grants";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { NO_STORE_HEADERS } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";

/**
 * Prefix for this route's own `checkApiRateLimit` buckets — separate from the
 * public read API's bare-IP keys and from the subscribe token routes, so a
 * burst against one surface cannot starve another (same reasoning as
 * `checkIntakeRateLimit("contact")` vs `("access-request")` in lib/rate-limit.ts,
 * whose separation is the `surface` predicate on every read).
 */
const RATE_BUCKET_PREFIX = "access-confirm:";

/**
 * Magic-link confirm target. Always redirects same-origin to a hardcoded
 * status page path — the redirect target is never derived from user input,
 * so there is no open-redirect surface here.
 *
 * The minted `accessToken` is carried to `/access/confirmed` in a URL
 * FRAGMENT (`#token=...`), never a query param: fragments are stripped by
 * the browser before the request line is sent, so they never reach a
 * `Referer` header or get logged server-side by anything reading the
 * request URL (this route's own access log included).
 *
 * UNCACHEABLE (measured on prod 2026-09-27 on the sibling subscribe routes): a
 * Cloudflare cache rule makes every non-`/admin` GET cache-eligible, and with
 * no origin directive Cloudflare supplies `public, max-age=14400`. That is
 * sharper here than anywhere else on the site — the success redirect's
 * `Location` carries the minted access token itself, so a stored copy would
 * hand that token to the next caller of the same URL for up to 4 hours.
 *
 * RATE LIMITED with the in-memory burst limiter, deliberately not a DB-backed
 * one: each call costs Neon queries, so a DB-backed counter would add the very
 * queries the limit exists to prevent.
 */
export async function GET(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = await confirmAccessGrant(token);

  if (result.status === "invalid") {
    return NextResponse.redirect(new URL("/access/invalid", request.url), {
      headers: NO_STORE_HEADERS,
    });
  }

  return NextResponse.redirect(
    new URL(`/access/confirmed#token=${encodeURIComponent(result.accessToken)}`, request.url),
    { headers: NO_STORE_HEADERS }
  );
}
