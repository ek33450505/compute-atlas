import { methodNotAllowed, NO_STORE_HEADERS, notAvailable } from "@/lib/api-response";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { redactedErrorCode } from "@/lib/db-error";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { getBillingCustomerId, getGrantByAccessToken } from "@/lib/dataset-grants";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";
import { siteConfig } from "@/lib/site";
import { createBillingPortalSession, StripeConfigError } from "@/lib/stripe";

const RETURN_PATH = "/access/billing-return";

/** The ONE failure outcome: no token probing, no cause. Relative-to-request, so it works on any host. */
function unavailable(request: Request): Response {
  const url = new URL(`${RETURN_PATH}?status=unavailable`, request.url);
  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: url.toString() } });
}

/**
 * Opens a Stripe billing portal session for a commercial grant holder. Native form POST (`t` = the
 * personal access token, in the body only), 303 to Stripe on success. Every failure is the same 303 to
 * `/access/billing-return?status=unavailable`. The token and customer id never reach a URL, log or
 * Stripe call (Stripe gets only the customer id).
 */
export async function POST(request: Request) {
  if (!isDatasetSharingEnabled() || !isCommercialTierEnabled()) return notAvailable();

  // A cross-site POST cannot burn a shared IP's budget; an absent header is allowed, the limit is the control.
  if (request.headers.get("sec-fetch-site") === "cross-site") return unavailable(request);

  try {
    const ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    const gate = await checkIntakeRateLimit("commercial-billing-portal", ipHash);
    if (!gate.ok) return unavailable(request);
    await recordIntakeAttempt("commercial-billing-portal", ipHash);
  } catch (err) {
    console.error(`commercial-billing-portal rate-limit accounting failed (sqlstate: ${redactedErrorCode(err)})`);
    return unavailable(request);
  }

  let token: FormDataEntryValue | null = null;
  try {
    token = (await request.formData()).get("t");
  } catch {
    // Not a form body: treated like a missing token.
  }
  if (typeof token !== "string" || token === "") return unavailable(request);

  let url: string;
  try {
    const resolved = await getGrantByAccessToken(token);
    if (resolved.state !== "active" || resolved.grant.tier !== "commercial") return unavailable(request);
    const customerId = await getBillingCustomerId(resolved.grant.id);
    if (!customerId) return unavailable(request);
    url = await createBillingPortalSession({ customerId, returnUrl: `${siteConfig.url}${RETURN_PATH}` });
  } catch (err) {
    // Never log the error object: DB errors embed bound params (the token hash), Stripe errors request params.
    const code = err instanceof StripeConfigError ? "config" : redactedErrorCode(err);
    console.error(`commercial-billing-portal failed (code: ${code})`);
    return unavailable(request);
  }

  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: url } });
}

// No OPTIONS export on purpose (see app/api/access/checkout/route.ts); GET gets a no-store 405.
export const GET = () => methodNotAllowed(["POST", "OPTIONS"]);
