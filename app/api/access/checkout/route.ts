import { methodNotAllowed, NO_STORE_HEADERS, notAvailable } from "@/lib/api-response";
import { commercialCheckoutInputSchema, startCommercialCheckout } from "@/lib/commercial-checkout";
import { COMMERCIAL_PATH } from "@/lib/commercial-plans";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { redactedErrorCode } from "@/lib/db-error";
import { getDb } from "@/lib/db/client";
import { siteConfig } from "@/lib/site";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";

type CheckoutError = "plan" | "busy" | "unavailable" | "details" | "terms" | "request";

/** 303 back to the commercial page. Relative-to-request, so it works on any host. */
function backWithError(request: Request, error: CheckoutError): Response {
  const url = new URL(`${COMMERCIAL_PATH}?error=${error}`, request.url);
  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: url.toString() } });
}

/**
 * Checkout entry point for the commercial tier. Takes a native HTML form POST (`plan`, `email`,
 * `name`, `organization`, `acceptTerms`) so the page works without JS, and answers 303 to PayPal's approval page.
 * Submitted values are never echoed into a redirect.
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

  // Defence in depth: a cross-site POST cannot burn a shared IP's hourly budget. Absent headers (older clients) are
  // allowed; the rate limit below is the real control. Our own form is same-origin, so same-site (a sibling
  // subdomain) and a foreign or opaque `Origin` are refused too.
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return backWithError(request, "request");
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin && origin !== new URL(siteConfig.url).origin) {
    return backWithError(request, "request");
  }

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

  let form: FormData | null = null;
  try {
    form = await request.formData();
  } catch {
    // Not a form body: treated like invalid details.
  }
  if (!form) return backWithError(request, "details");

  // A missing or unrecognised plan keeps its own code; the terms checkbox is checked before the other fields so
  // the message points at the one thing the buyer can fix.
  const plan = form.get("plan");
  if (plan !== "monthly" && plan !== "annual") return backWithError(request, "plan");
  if (form.get("acceptTerms") !== "on") return backWithError(request, "terms");

  const parsed = commercialCheckoutInputSchema.safeParse({
    plan,
    email: form.get("email"),
    name: form.get("name"),
    organization: form.get("organization"),
    acceptTerms: form.get("acceptTerms"),
  });
  if (!parsed.success) return backWithError(request, "details");

  const result = await startCommercialCheckout(getDb(), parsed.data);
  if (!result.ok) return backWithError(request, result.reason);
  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: result.approveUrl } });
}

// No OPTIONS export on purpose: only our own same-origin form posts here, so a cross-origin
// preflight gets no CORS headers (Next's automatic OPTIONS) and the browser refuses the POST.
// POST-only: answer GET with a no-store 405 (a bare framework 405 is edge-cacheable).
// Allow lists OPTIONS because Next answers it automatically for every route module.
export const GET = () => methodNotAllowed(["POST", "OPTIONS"]);
