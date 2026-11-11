import { methodNotAllowed, NO_STORE_HEADERS, notAvailable } from "@/lib/api-response";
import { COMMERCIAL_PATH } from "@/lib/commercial-plans";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { redactedErrorCode } from "@/lib/db-error";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";
import type { CommercialPlan } from "@/lib/paypal";

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
 * Checkout entry point for the commercial tier. Takes a native HTML form POST (`plan` field)
 * so the page works without JS. TEMPORARY: after the checks it answers the standard 403 "not available" until the PayPal
 * checkout lands; the commercial tier is dark behind the flag until then.
 */
export async function POST(request: Request) {
  // Kill switch first: no DB, provider or body work.
  if (!isCommercialCheckoutOpen()) return notAvailable();

  // Money must not be taken while the maintainer alert cannot be sent: both the alert recipient and the
  // mail key must be set. Checked before any rate-limit or provider work; the response never says which.
  if (!process.env.CONTACT_TO_EMAIL?.trim() || !process.env.RESEND_API_KEY?.trim()) {
    console.error("commercial-checkout refused: alert mail not configured");
    return backWithError(request, "unavailable");
  }

  // Defence in depth: a cross-site POST cannot burn a shared IP's hourly budget. An absent header
  // (older clients) is allowed; the rate limit below is the real control.
  if (request.headers.get("sec-fetch-site") === "cross-site") return backWithError(request, "plan");

  // Gate on PRIOR attempts, then record this one before any content-dependent branch, so a bad
  // plan costs a unit too (same ordering as app/api/access/request/route.ts). Card-testing is
  // the threat: every checkout will be a PayPal API call an anonymous visitor can trigger.
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

  // Placeholder until the PayPal checkout replaces it; nothing is created or charged.
  return notAvailable();
}

// No OPTIONS export on purpose: only our own same-origin form posts here, so a cross-origin
// preflight gets no CORS headers (Next's automatic OPTIONS) and the browser refuses the POST.
// POST-only: answer GET with a no-store 405 (a bare framework 405 is edge-cacheable).
// Allow lists OPTIONS because Next answers it automatically for every route module.
export const GET = () => methodNotAllowed(["POST", "OPTIONS"]);
