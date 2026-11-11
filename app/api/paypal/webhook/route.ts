/**
 * PayPal webhook for the commercial tier.
 *
 * The signature, not the network path, is the authentication: `verifyWebhookSignature` asks PayPal to
 * verify the exact raw body text (spliced in unchanged, never re-serialised) and returns the event it
 * verified. The route acts only on that returned object, never on a re-parse of the body.
 *
 * Status codes, as PayPal's retry logic reads them:
 *   200  handled, duplicate or ignored: stop retrying.
 *   400  signature did not verify (the log line carries the reason). PayPal redelivers any
 *        non-2xx, 400 included (observed 2026-11-11: 7 redeliveries of one 400 over ~2 h), so a 400
 *        is not "nothing to retry".
 *   403  tier flag off.
 *   413  body over the cap (rejected before verification).
 *   500  verification could not run (PayPal transport or config failure) or processing failed:
 *        PayPal redelivers.
 *
 * No CORS: PayPal posts server to server. Logs carry codes only: never the body, headers, event
 * resource, an email or a token.
 */
import { jsonResponse, methodNotAllowed, notAvailable } from "@/lib/api-response";
import { processPaypalEvent } from "@/lib/commercial-activation";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { redactedErrorCode } from "@/lib/db-error";
import { PayPalApiError, PayPalConfigError, verifyWebhookSignature } from "@/lib/paypal";

export const dynamic = "force-dynamic";

/** PayPal events are a few KiB; anything near this is not one. */
const MAX_BODY_BYTES = 512 * 1024;

const tooLarge = () => jsonResponse({ error: "payload too large" }, { status: 413 });

/** Streams the body, cancelling as soon as it passes the cap. Returns null when over the cap. */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** Codes only: PayPal status/name/debug id, or the redacted DB code. */
function errorCodes(err: unknown): string {
  if (err instanceof PayPalApiError) {
    return `status=${err.status} paypalName=${err.paypalName ?? "none"} debugId=${err.debugId ?? "none"}`;
  }
  if (err instanceof PayPalConfigError) return `config=${err.variable}`;
  return `code=${redactedErrorCode(err)}`;
}

/** A 404 for an event younger than this may be PayPal replication lag, not a permanent absence. */
export const TERMINAL_404_MIN_AGE_MS = 2 * 60 * 60 * 1000;

function isOldEnough(createTime: unknown): boolean {
  if (typeof createTime !== "string") return false;
  const at = Date.parse(createTime);
  return Number.isFinite(at) && Date.now() - at > TERMINAL_404_MIN_AGE_MS;
}

/** Event ids and types are PayPal identifiers; anything else is not logged. */
function safeToken(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(v) ? v : "none";
}

export async function POST(request: Request) {
  // Gated on the tier flag, not the checkout-open flag: money already taken must still be processed
  // (activations, cancellations, renewals) after checkout is closed.
  if (!isCommercialTierEnabled()) return notAvailable();

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();

  // Verification is over the exact bytes, so keep them raw.
  const raw = await readCapped(request.body);
  if (raw === null) return tooLarge();

  // No pre-verify throttle, by decision: forged requests are bounded by the production edge-secret
  // header (proxy.ts) and the offline pre-checks inside verifyWebhookSignature. A per-IP limiter was
  // rejected because PayPal's own deliveries and retries share IPs and would be throttled with them.
  let result: Awaited<ReturnType<typeof verifyWebhookSignature>>;
  try {
    result = await verifyWebhookSignature(request.headers, raw);
  } catch (err) {
    // lint-no-raw-error-logs: allow -- errorCodes() logs only PayPalApiError status plus regex-whitelisted name/debugId, PayPalConfigError's env variable name, or redactedErrorCode(err); never a message or bound params
    console.error(`paypal-webhook verify failed (${errorCodes(err)})`);
    return jsonResponse({ error: "processing failed" }, { status: 500 });
  }
  if (!result.verified) {
    const tid = request.headers.get("paypal-transmission-id");
    const safeTid = tid !== null && /^[A-Za-z0-9-]{1,64}$/.test(tid) ? ` transmission=${tid}` : "";
    const detail =
      (result.status !== undefined ? ` status=${result.status}` : "") +
      (result.paypalName ? ` paypalName=${result.paypalName}` : "") +
      (result.debugId ? ` debugId=${result.debugId}` : "") +
      (result.verdict ? ` verdict=${result.verdict}` : "");
    console.error(`paypal-webhook signature not verified reason=${result.reason}${detail}${safeTid}`);
    return jsonResponse({ error: "invalid signature" }, { status: 400 });
  }

  try {
    await processPaypalEvent(result.event);
    return jsonResponse({ received: true });
  } catch (err) {
    const ev = result.event as { id?: unknown; event_type?: unknown; create_time?: unknown };
    const idType = `eventId=${safeToken(ev.id)} eventType=${safeToken(ev.event_type)}`;
    // PayPal says the subscription does not exist. Right after creation that can be replication lag, so
    // it is terminal only for an event old enough that lag is ruled out; a younger or undated event
    // answers 500 and PayPal's ~3-day retries end as terminal on a later delivery if the 404 persists.
    if (err instanceof PayPalApiError && err.status === 404 && isOldEnough(ev.create_time)) {
      // lint-no-raw-error-logs: allow -- errorCodes() logs only PayPalApiError status plus regex-whitelisted name/debugId, PayPalConfigError's env variable name, or redactedErrorCode(err); never a message or bound params
      console.error(`paypal-webhook terminal (${errorCodes(err)} ${idType})`);
      return jsonResponse({ received: true, terminal: true });
    }
    // lint-no-raw-error-logs: allow -- errorCodes() logs only PayPalApiError status plus regex-whitelisted name/debugId, PayPalConfigError's env variable name, or redactedErrorCode(err); never a message or bound params
    console.error(`paypal-webhook processing failed (${errorCodes(err)} ${idType})`);
    return jsonResponse({ error: "processing failed" }, { status: 500 });
  }
}

// No OPTIONS export on purpose: PayPal posts server to server, so no CORS headers are ever wanted.
// Allow lists OPTIONS because Next answers it automatically for every route module.
export const GET = () => methodNotAllowed(["POST", "OPTIONS"]);
