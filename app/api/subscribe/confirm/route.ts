import { NextResponse } from "next/server";

import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { NO_STORE_HEADERS } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { confirmSubscription } from "@/lib/subscribe";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_SECONDS,
  createConsentValue,
} from "@/lib/subscribe-consent";

/**
 * Prefix for this route's own `checkApiRateLimit` buckets, so it counts
 * separately from the public read API (which keys on the bare IP) and from
 * the sibling token routes. Separate budgets on purpose, the same reasoning
 * `lib/rate-limit.ts` gives for `checkIntakeRateLimit("contact")` vs
 * `("leads")`, whose budgets stay separate via the `surface` predicate on
 * every read: a burst against one surface must not silently starve
 * another. Ordinary page browsing hits the read API dozens of times a minute;
 * a subscriber clicks a confirm link once, and must not be refused because of
 * it.
 */
const RATE_BUCKET_PREFIX = "sub-confirm:";

/**
 * Magic-link confirm target. Always redirects same-origin to a hardcoded
 * status page path — the redirect target is never derived from user input,
 * so there is no open-redirect surface here.
 *
 * UNCACHEABLE (measured on prod 2026-09-27): a Cloudflare cache rule makes
 * every non-`/admin` GET cache-eligible, and because this route sent no
 * directive of its own Cloudflare supplied `public, max-age=14400` — putting a
 * single-use token in a cache key and caching the *outcome* of consuming it
 * for 4 hours (observed going `MISS` → `EXPIRED`).
 *
 * RATE LIMITED with the in-memory burst limiter, deliberately not a DB-backed
 * one: this route costs 1-2 Neon queries per call (a garbage token costs two —
 * the legacy-raw fallback in `confirmSubscription` fires for anything that
 * isn't 64-hex), so a DB-backed counter would add the very queries the limit
 * exists to prevent.
 */
export async function GET(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  const token = new URL(request.url).searchParams.get("token") ?? "";
  const { status, email } = await confirmSubscription(token);

  const path = status === "invalid" ? "/subscribe/invalid" : "/subscribe/confirmed";
  const response = NextResponse.redirect(new URL(path, request.url), {
    headers: NO_STORE_HEADERS,
  });

  // Mint the address-bound consent proof that gates the auto-confirm shortcut
  // in subscribeToTarget. `email` is present on exactly the two non-`invalid`
  // outcomes and goes straight into an HMAC — never the URL, the body, or a
  // log.
  //
  // `"already"` COUNTS as a confirm, deliberately. Both outcomes require
  // possession of a token that was only ever delivered to that address's
  // inbox, so both prove the same thing about the requester; the difference is
  // that `"already"` is replayable where `"confirmed"` fires once. That
  // replayability is the price of avoiding a real failure mode: mail clients
  // and link scanners PREFETCH URLs, which consumes the one-time `"confirmed"`
  // outcome before the human ever clicks, leaving the genuine user's own click
  // answering `"already"`. Gating on `"confirmed"` alone would deny the cookie
  // to a large share of exactly the people this shortcut exists for. The
  // residual risk is bounded: a replayed old confirm URL yields a proof for
  // the SAME address it was issued to, lasting CONSENT_MAX_AGE_SECONDS, and
  // the shortcut it unlocks still requires canAutoConfirm's history conditions
  // (an existing confirmed row, under the weekly cap, no prior unsubscribe
  // from that target) — strictly less than what holding that token already
  // grants its bearer.
  //
  // No cookie on `invalid`, which leaks nothing new: the redirect path already
  // says the token was rejected.
  if (email) {
    const consent = createConsentValue(email);
    if (consent) {
      response.cookies.set(CONSENT_COOKIE_NAME, consent, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: CONSENT_MAX_AGE_SECONDS,
      });
    }
  }

  return response;
}
