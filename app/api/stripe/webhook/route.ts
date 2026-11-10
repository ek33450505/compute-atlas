/**
 * Stripe webhook for the commercial tier.
 *
 * Subscribe the endpoint to exactly these six event types:
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, invoice.paid,
 *   customer.subscription.updated, customer.subscription.deleted.
 *
 * There is deliberately no proxy.ts exemption. This relies on Stripe reaching the origin through
 * Cloudflare, which injects the edge header: a precondition to verify in the test-mode E2E, not yet
 * verified. The signature, not the network path, is the authentication.
 *
 * Status codes, as Stripe's retry logic reads them:
 *   200  handled, duplicate or ignored: stop retrying.
 *   400  bad or missing signature: a forged or corrupt request, nothing to retry.
 *   403  flag off.
 *   403  also from proxy.ts when the Cloudflare edge header is missing (direct-to-origin, or
 *        EDGE_SHARED_SECRET rotated without updating Cloudflare): Stripe retries; check the
 *        endpoint's delivery log.
 *   413  body over the cap (rejected before verification).
 *   503  Stripe is not configured here (missing secret): Stripe retries until it is.
 *   500  processing failed: Stripe redelivers, and the event stays unprocessed until it succeeds.
 *
 * Runs on the default Node.js runtime (Stripe SDK + crypto); the Edge runtime is deprecated.
 * Logs carry the event id and type and a redacted error code only: never the body, signature,
 * event object, an email or a token.
 */
import { jsonResponse, methodNotAllowed, notAvailable } from "@/lib/api-response";
import { makeCommercialSideEffects } from "@/lib/commercial-actions";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { processStripeEvent } from "@/lib/commercial-grants";
import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import {
  getStripeClient,
  StripeConfigError,
  StripeSignatureError,
  verifyStripeWebhook,
} from "@/lib/stripe";

export const dynamic = "force-dynamic";

/** Stripe events are a few KiB; anything near this is not one. */
const MAX_BODY_BYTES = 512 * 1024;

const tooLarge = () => jsonResponse({ error: "payload too large" }, { status: 413 });

/** Streams the body, cancelling as soon as it passes the cap. Returns null when over the cap. */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
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
  return out;
}

export async function POST(request: Request) {
  if (!isCommercialTierEnabled()) return notAvailable();

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();

  // The signature is over the exact bytes, so keep them raw, never re-serialized JSON.
  const raw = await readCapped(request.body);
  if (!raw) return tooLarge();

  let event: ReturnType<typeof verifyStripeWebhook>;
  let client: ReturnType<typeof getStripeClient>;
  try {
    client = getStripeClient();
    event = verifyStripeWebhook(raw, request.headers.get("stripe-signature"), client);
  } catch (err) {
    if (err instanceof StripeConfigError) {
      console.error("stripe webhook: not configured");
      return jsonResponse({ error: "unavailable" }, { status: 503 });
    }
    if (err instanceof StripeSignatureError) {
      return jsonResponse({ error: "invalid signature" }, { status: 400 });
    }
    console.error(`stripe webhook: verification failed (${redactedErrorCode(err)})`);
    return jsonResponse({ error: "processing failed" }, { status: 500 });
  }

  try {
    const db = getDb();
    await processStripeEvent(event, {
      db,
      stripe: client,
      beforeComplete: makeCommercialSideEffects({ db, stripe: client }),
    });
    return jsonResponse({ received: true });
  } catch (err) {
    console.error(
      `stripe webhook: processing failed (${redactedErrorCode(err)}) id=${event.id} type=${event.type}`
    );
    return jsonResponse({ error: "processing failed" }, { status: 500 });
  }
}

export const GET = () => methodNotAllowed(["POST"]);
