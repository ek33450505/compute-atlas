import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { formRedirect, readFormToken } from "@/lib/access-form";
import { corsPreflight, jsonResponse, methodNotAllowed, notAvailable } from "@/lib/api-response";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { requestRenewal } from "@/lib/dataset-grants";
import { redactedErrorCode } from "@/lib/db-error";
import { extractTrustedClientIp } from "@/lib/rate-limit";

/** Separate from the other access routes' buckets, so a burst against one cannot starve another. */
const RATE_BUCKET_PREFIX = "access-renew:";

/**
 * Renewal request, POSTed by the form on `/access/renew?token=...` (a page, so a mail scanner's GET
 * prefetch cannot request anything). `requested` and `invalid` redirect to fixed pages; no mail is sent.
 */
export async function POST(request: Request) {
  if (!isDatasetSharingEnabled()) return notAvailable();

  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) return tooManyRequests(rate.retryAfter);

  const token = await readFormToken(request);
  if (!token) return formRedirect(request, "/access/invalid");

  try {
    const result = await requestRenewal(token);
    return formRedirect(request, result.outcome === "requested" ? "/access/renewed" : "/access/invalid");
  } catch (err) {
    console.error(`access renew failed (sqlstate: ${redactedErrorCode(err)})`);
    return jsonResponse({ error: "Temporarily unavailable. Please try again later." }, { status: 503 });
  }
}

// `public-write`: anonymous POST only; the path exports no PATCH/DELETE.
export function OPTIONS() {
  return corsPreflight("public-write");
}

// POST-only: answer GET with a no-store 405 (a bare framework 405 is edge-cacheable).
export function GET() {
  return methodNotAllowed(["POST", "OPTIONS"]);
}
