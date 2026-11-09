import { NextResponse } from "next/server";

import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { NO_STORE_HEADERS, corsPreflight, jsonResponse } from "@/lib/api-response";
import { DATASET_TOKEN_RE } from "@/lib/dataset-grants";
import { unsubscribeDatasetNotices } from "@/lib/dataset-unsubscribe";
import { redactedErrorCode } from "@/lib/db-error";
import { isOneClickUnsubscribe } from "@/lib/one-click-unsubscribe";
import { extractTrustedClientIp, normaliseIpForBucketing } from "@/lib/rate-limit";

/**
 * Prefix for this route's own `checkApiRateLimit` buckets, separate from the
 * public read API's bare-IP keys and from the sibling token routes. GET and POST
 * share it: one surface, and the POST costs a Neon SELECT plus a write.
 */
const RATE_BUCKET_PREFIX = "dataset-unsub:";

const rateKey = (request: Request): string =>
  RATE_BUCKET_PREFIX + normaliseIpForBucketing(extractTrustedClientIp(request.headers));

/** Same-origin 303 to a hardcoded page, no-store. Paths are never derived from input (no open redirect). */
function seeOther(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), { status: 303, headers: NO_STORE_HEADERS });
}

/*
 * This route (and its two pages) deliberately ignore DATASET_SHARING_ENABLED. If the kill switch is flipped
 * after notices went out, recipients must still be able to opt out: CAN-SPAM expects opt-outs to be honoured
 * for ~30 days after a send, and an unsubscribe exposes no data, so there is nothing for the switch to protect.
 */

/**
 * Browser-navigated unsubscribe link (the footer link in the weekly edition notice). NEVER mutates: mail
 * scanners prefetch every link in a message, and an opt-out is durable, so a GET only redirects to the
 * `/access/unsubscribe` interstitial whose POST button does the work. No DB call. The token is only carried
 * to the interstitial when it has the right shape; anything else goes to the same interstitial with NO token
 * (its unsubscribe-specific invalid copy), so a redirect can never be built from arbitrary input.
 *
 * `no-store`: a Cloudflare cache rule makes every non-`/admin` GET cache-eligible, and the URL carries a token.
 */
export async function GET(request: Request) {
  const rate = checkApiRateLimit(rateKey(request));
  if (!rate.ok) return tooManyRequests(rate.retryAfter);

  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!DATASET_TOKEN_RE.test(token)) return seeOther(request, "/access/unsubscribe");
  return seeOther(request, `/access/unsubscribe?token=${encodeURIComponent(token)}`);
}

/**
 * Two kinds of POST share this handler, both authorised by the token in the URL.
 *
 * RFC 8058 one-click (body exactly `List-Unsubscribe=One-Click`, sent by mail clients in response to the
 * `List-Unsubscribe-Post` header): answers a plain 200 with no body, because a client does not follow
 * redirects. Interstitial form (any other body, normally empty): 303 to `/access/unsubscribed`.
 *
 * ENUMERATION-SAFE: an unknown or malformed token gets exactly the same response as a real one, so the
 * route is not an oracle for which tokens exist.
 *
 * A DB failure is a 503 for BOTH kinds: a one-click client retries it, and for the form a redirect to
 * `/access/unsubscribed` would claim an opt-out that did not happen (and `/access/invalid` would call a
 * good link bad). It matches `/api/access/confirm`'s DB-error answer; the person can press the button again.
 *
 * Every response is `no-store`. No kill-switch gate (see the note above the GET handler).
 */
export async function POST(request: Request) {
  const rate = checkApiRateLimit(rateKey(request));
  if (!rate.ok) return tooManyRequests(rate.retryAfter);

  const oneClick = await isOneClickUnsubscribe(request);
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    await unsubscribeDatasetNotices(token);
  } catch (err) {
    // The thrown error can embed the address (Drizzle); log the SQLSTATE only. Never the token or email.
    console.error(`dataset unsubscribe failed (sqlstate: ${redactedErrorCode(err)})`);
    return jsonResponse({ error: "Temporarily unavailable. Please try again later." }, { status: 503 });
  }

  if (oneClick) return new Response(null, { status: 200, headers: NO_STORE_HEADERS });
  return seeOther(request, "/access/unsubscribed");
}

// `public-write`: GET and POST, both authorised by a token in the URL rather than a header, so
// `Authorization` is advertised to nobody, and there is no PATCH/DELETE to advertise either.
export function OPTIONS() {
  return corsPreflight("public-write");
}
