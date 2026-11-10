import { methodNotAllowed, NO_STORE_HEADERS, notAvailable } from "@/lib/api-response";
import { COMMERCIAL_PATH } from "@/lib/commercial-plans";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { redactedErrorCode } from "@/lib/db-error";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";
import { createCommercialCheckoutSession, StripeConfigError, type CommercialPlan } from "@/lib/stripe";

type CheckoutError = "plan" | "busy" | "unavailable";

/** 303 back to the commercial page. Relative-to-request, so it works on any host. */
function backWithError(request: Request, error: CheckoutError): Response {
  const url = new URL(`${COMMERCIAL_PATH}?error=${error}`, request.url);
  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: url.toString() } });
}

function parsePlan(value: FormDataEntryValue | null): CommercialPlan | null {
  return value === "monthly" || value === "annual" ? value : null;
}

/**
 * Starts a Stripe Checkout session for the commercial tier. Takes a native HTML form POST
 * (`plan` field) so the page works without JS, and answers with a 303 either to Stripe or back
 * to the page with `?error=`. Writes nothing to our DB beyond the rate-limit attempt row.
 */
export async function POST(request: Request) {
  // Kill switch first: no DB, Stripe or body work.
  if (!isCommercialTierEnabled()) return notAvailable();

  // Money must not be taken while the maintainer alert cannot be sent: both the alert recipient and the
  // mail key must be set. Checked before any rate-limit or Stripe work; the response never says which.
  if (!process.env.CONTACT_TO_EMAIL?.trim() || !process.env.RESEND_API_KEY?.trim()) {
    console.error("commercial-checkout refused: alert mail not configured");
    return backWithError(request, "unavailable");
  }

  // Defence in depth: a cross-site POST cannot burn a shared IP's hourly budget. An absent header
  // (older clients) is allowed; the rate limit below is the real control.
  if (request.headers.get("sec-fetch-site") === "cross-site") return backWithError(request, "plan");

  // Gate on PRIOR attempts, then record this one before any content-dependent branch, so a bad
  // plan costs a unit too (same ordering as app/api/access/request/route.ts). Card-testing is
  // the threat: every Checkout session is a Stripe API call an anonymous visitor can trigger.
  let gate: { ok: boolean };
  try {
    const ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    gate = await checkIntakeRateLimit("commercial-checkout", ipHash);
    if (gate.ok) await recordIntakeAttempt("commercial-checkout", ipHash);
  } catch (err) {
    // Fail closed, SQLSTATE only (bound params include the IP hash).
    console.error(`commercial-checkout rate-limit accounting failed (sqlstate: ${redactedErrorCode(err)})`);
    return backWithError(request, "unavailable");
  }
  if (!gate.ok) return backWithError(request, "busy");

  let plan: CommercialPlan | null = null;
  try {
    plan = parsePlan((await request.formData()).get("plan"));
  } catch {
    // Not a form body: treated like an invalid plan.
  }
  if (!plan) return backWithError(request, "plan");

  let url: string;
  try {
    ({ url } = await createCommercialCheckoutSession({ plan }));
  } catch (err) {
    // Never log the error object or the session: Stripe errors can carry request params.
    const code = err instanceof StripeConfigError ? "config" : redactedErrorCode(err);
    console.error(`commercial-checkout session failed (code: ${code})`);
    return backWithError(request, "unavailable");
  }

  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: url } });
}

// No OPTIONS export on purpose: only our own same-origin form posts here, so a cross-origin
// preflight gets no CORS headers (Next's automatic OPTIONS) and the browser refuses the POST.
// POST-only: answer GET with a no-store 405 (a bare framework 405 is edge-cacheable).
// Allow lists OPTIONS because Next answers it automatically for every route module.
export const GET = () => methodNotAllowed(["POST", "OPTIONS"]);
