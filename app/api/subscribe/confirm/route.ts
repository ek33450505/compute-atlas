import { NextResponse } from "next/server";

import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { corsPreflight, NO_STORE_HEADERS } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { redactedErrorCode } from "@/lib/db-error";
import { confirmSubscription, peekConfirmToken } from "@/lib/subscribe";
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

/** Same-origin redirect to a hardcoded path, never derived from user input. */
function redirectTo(request: Request, path: string, status: 303 | 307): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

/**
 * Mints the address-bound consent proof that gates the auto-confirm shortcut
 * in subscribeToTarget. `email` goes straight into an HMAC, never the URL, the
 * body, or a log.
 *
 * `"already"` COUNTS as a confirm, deliberately. Both outcomes require
 * possession of a token that was only ever delivered to that address's inbox,
 * so both prove the same thing about the requester; `"already"` is merely
 * replayable where `"confirmed"` fires once. Gating on `"confirmed"` alone
 * would deny the cookie to anyone whose confirm was completed first (a second
 * click, a second tab). The residual risk is bounded: a replayed old confirm
 * URL yields a proof for the SAME address it was issued to, lasting
 * CONSENT_MAX_AGE_SECONDS, and the shortcut it unlocks still requires
 * canAutoConfirm's history conditions (an existing confirmed row, under the
 * weekly cap, no prior unsubscribe from that target) — strictly less than what
 * holding that token already grants its bearer. No cookie on `invalid`.
 */
function setConsentCookie(response: NextResponse, email: string | undefined): void {
  if (!email) return;
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

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get("token") ?? "";
}

/**
 * Magic-link confirm target. NEVER mutates: mail scanners prefetch every link
 * in a message, so a GET that consumed the token would let a stranger's
 * security gateway confirm a subscription nobody read. A GET only looks the
 * token up and redirects: a pending token to the `/subscribe/confirm`
 * interstitial (whose POST button confirms), an already-confirmed one to
 * `/subscribe/confirmed` with the consent cookie (a second click or a
 * scanner-first race still counts, see `setConsentCookie`), anything else to
 * `/subscribe/invalid`. Redirect targets are hardcoded paths, so there is no
 * open-redirect surface.
 *
 * UNCACHEABLE (measured on prod 2026-09-27): a Cloudflare cache rule makes
 * every non-`/admin` GET cache-eligible, and without an origin directive
 * Cloudflare supplied `public, max-age=14400`, putting a token in a cache key.
 *
 * RATE LIMITED with the in-memory burst limiter, deliberately not a DB-backed
 * one: this route costs 1-2 Neon queries per call (a garbage token costs two —
 * the legacy-raw fallback fires for anything that isn't 64-hex).
 */
export async function GET(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  const token = tokenFrom(request);
  let peeked: Awaited<ReturnType<typeof peekConfirmToken>>;
  try {
    peeked = await peekConfirmToken(token);
  } catch (err) {
    // The thrown error can embed the address (Drizzle); log the SQLSTATE only.
    console.error(`confirm route failed (sqlstate: ${redactedErrorCode(err)})`);
    return redirectTo(request, "/subscribe/invalid", 307);
  }
  const { status, email } = peeked;

  if (status === "pending") {
    return redirectTo(request, `/subscribe/confirm?token=${encodeURIComponent(token)}`, 307);
  }
  if (status === "invalid") {
    return redirectTo(request, "/subscribe/invalid", 307);
  }
  const response = redirectTo(request, "/subscribe/confirmed", 307);
  setConsentCookie(response, email);
  return response;
}

/**
 * The only path that confirms: the interstitial's form POST, token in the
 * query string like unsubscribe's. Answers a 303 to a hardcoded status page; a
 * DB failure redirects to `/subscribe/invalid` after a SQLSTATE-only log (the
 * Drizzle error embeds the address). Every response is `no-store`.
 */
export async function POST(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  try {
    const { status, email } = await confirmSubscription(tokenFrom(request));
    if (status === "invalid") {
      return redirectTo(request, "/subscribe/invalid", 303);
    }
    const response = redirectTo(request, "/subscribe/confirmed", 303);
    setConsentCookie(response, email);
    return response;
  } catch (err) {
    console.error(`confirm route failed (sqlstate: ${redactedErrorCode(err)})`);
    return redirectTo(request, "/subscribe/invalid", 303);
  }
}

// `public-write`: GET and POST, both authorised by a token in the URL.
export function OPTIONS() {
  return corsPreflight("public-write");
}
