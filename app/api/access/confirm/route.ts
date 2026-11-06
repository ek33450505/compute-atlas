import { NextResponse } from "next/server";

import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { NO_STORE_HEADERS } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";

/**
 * Prefix for this route's own `checkApiRateLimit` buckets — separate from the
 * public read API's bare-IP keys and from the subscribe token routes, so a
 * burst against one surface cannot starve another.
 */
const RATE_BUCKET_PREFIX = "access-confirm:";

/**
 * Old magic-link target. Access grants are no longer activated: every request
 * redirects same-origin to the hardcoded `/contact` path (never derived from
 * user input, so no open-redirect surface) without reading the token or
 * touching the database. `no-store`, because a Cloudflare cache rule makes
 * every non-`/admin` GET cache-eligible. Rate limited with the in-memory
 * burst limiter, so the limit itself costs no queries.
 */
export async function GET(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  return NextResponse.redirect(new URL("/contact", request.url), {
    headers: NO_STORE_HEADERS,
  });
}
