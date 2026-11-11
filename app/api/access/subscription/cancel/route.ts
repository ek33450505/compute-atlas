import { methodNotAllowed, NO_STORE_HEADERS, notAvailable } from "@/lib/api-response";
import { cancelOwnSubscription } from "@/lib/commercial-cancel";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { redactedErrorCode } from "@/lib/db-error";
import { DATASET_TOKEN_RE } from "@/lib/dataset-grants";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { siteConfig } from "@/lib/site";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";

/**
 * The result page is token-free ON PURPOSE: the download page needs `?t=<token>` to render, so a 303 back
 * to it would put the token in a Location header (and then in history and logs). It carries only a fixed
 * status value; no date, so a crafted link cannot make the page assert one.
 */
const RESULT_PATH = "/access/subscription-cancelled";

function redirect(request: Request, query: string): Response {
  const url = new URL(`${RESULT_PATH}?${query}`, request.url);
  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: url.toString() } });
}

/** The ONE failure outcome: no token probing, no cause. */
const failed = (request: Request): Response => redirect(request, "status=error");

/**
 * A subscriber cancels their own PayPal subscription. Native form POST (`t` = the personal access token and
 * `confirm` = "on", both in the body only). Every failure is the same 303 to `?status=error`; success is a
 * 303 to `?status=cancelled` (no date in the URL). Access is not cut: the grant runs to its paid-through date.
 */
export async function POST(request: Request) {
  if (!isDatasetSharingEnabled() || !isCommercialTierEnabled()) return notAvailable();

  // A cross-site POST cannot burn a shared IP's budget. Our own form is same-origin, so same-site is refused
  // too; an absent header is allowed and the rate limit is the control.
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return failed(request);
  // A present `Origin` must be ours (the request's own or the canonical site); absent is allowed.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin && origin !== new URL(siteConfig.url).origin) {
    return failed(request);
  }

  // Gate on PRIOR attempts, then record this one before any content-dependent branch; fail closed.
  try {
    const ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    const gate = await checkIntakeRateLimit("commercial-billing-portal", ipHash);
    if (!gate.ok) return failed(request);
    await recordIntakeAttempt("commercial-billing-portal", ipHash);
  } catch (err) {
    console.error(`commercial-cancel rate-limit accounting failed (sqlstate: ${redactedErrorCode(err)})`);
    return failed(request);
  }

  let token: FormDataEntryValue | null = null;
  let confirm: FormDataEntryValue | null = null;
  try {
    const form = await request.formData();
    token = form.get("t");
    confirm = form.get("confirm");
  } catch {
    // Not a form body: treated like a missing token.
  }
  if (typeof token !== "string" || !DATASET_TOKEN_RE.test(token)) return failed(request);
  if (confirm !== "on") return failed(request);

  const result = await cancelOwnSubscription(token);
  if (!result.ok) return failed(request);
  return redirect(request, "status=cancelled");
}

// No OPTIONS export on purpose (see app/api/access/checkout/route.ts); GET gets a no-store 405.
export const GET = () => methodNotAllowed(["POST", "OPTIONS"]);
