import { NextResponse, after } from "next/server";

import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { formRedirect, readFormToken } from "@/lib/access-form";
import { NO_STORE_HEADERS, corsPreflight, jsonResponse, notAvailable } from "@/lib/api-response";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { verifyDatasetRequest } from "@/lib/dataset-grants";
import { deliverDatasetAdminNotice } from "@/lib/dataset-mail";
import { redactedErrorCode } from "@/lib/db-error";
import { extractTrustedClientIp } from "@/lib/rate-limit";

/**
 * Prefix for this route's own `checkApiRateLimit` buckets — separate from the
 * public read API's bare-IP keys and from the subscribe token routes, so a
 * burst against one surface cannot starve another.
 */
const RATE_BUCKET_PREFIX = "access-confirm:";

/**
 * GET is the LEGACY handler and POST is the interstitial confirm. A GET must never confirm anything: a mail
 * scanner's prefetch would confirm a stranger's request. The verify mail links the page
 * `/access/confirm?token=...`, whose form POSTs here.
 *
 * GET, legacy: old magic-link target. Access grants are no longer activated: every request
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

/**
 * Interstitial confirm, POSTed by the form on `/access/confirm`. `verified` redirects to a fixed page, and on
 * the FIRST transition only (`result.mail` exists only then) the maintainer notice is scheduled; a repeat of
 * the same token reads `verified` with no mail. Everything else redirects to `/access/invalid`.
 */
export async function POST(request: Request) {
  if (!isDatasetSharingEnabled()) return notAvailable();

  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) return tooManyRequests(rate.retryAfter);

  const token = await readFormToken(request);
  if (!token) return formRedirect(request, "/access/invalid");

  let result: Awaited<ReturnType<typeof verifyDatasetRequest>>;
  try {
    result = await verifyDatasetRequest(token);
  } catch (err) {
    console.error(`access confirm failed (sqlstate: ${redactedErrorCode(err)})`);
    return jsonResponse({ error: "Temporarily unavailable. Please try again later." }, { status: 503 });
  }
  if (result.outcome !== "verified") return formRedirect(request, "/access/invalid");

  const mail = result.mail;
  if (mail?.kind === "dataset_admin_new_request") {
    after(() => deliverDatasetAdminNotice(mail));
  }
  return formRedirect(request, "/access/confirmed");
}

// `public-write`: anonymous POST only; the path exports no PATCH/DELETE.
export function OPTIONS() {
  return corsPreflight("public-write");
}
