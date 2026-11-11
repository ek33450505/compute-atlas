import { NO_STORE_HEADERS } from "@/lib/api-response";
import { activateFromPayPal } from "@/lib/commercial-activation";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { COMMERCIAL_PATH } from "@/lib/commercial-plans";
import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { commercialCheckoutsTable } from "@/lib/db/schema";
import { PayPalApiError, PayPalConfigError } from "@/lib/paypal";
import { eq } from "drizzle-orm";
import { after } from "next/server";

export const dynamic = "force-dynamic";

const ACTIVATION_TIMEOUT_MS = 8000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codes only: PayPal status/name/debug id, a config variable name, or the redacted DB code. */
function errorCodes(err: unknown): string {
  if (err instanceof PayPalApiError) {
    return `status=${err.status} paypalName=${err.paypalName ?? "none"} debugId=${err.debugId ?? "none"}`;
  }
  if (err instanceof PayPalConfigError) return `config=${err.variable}`;
  return `code=${redactedErrorCode(err)}`;
}

/** 303 relative to the request URL. This GET mutates, so it is no-store on both cache headers and noindex. */
function see(request: Request, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...NO_STORE_HEADERS,
      "X-Robots-Tag": "noindex",
      Location: new URL(path, request.url).toString(),
    },
  });
}

/**
 * Where PayPal sends the buyer after approval. The query is trusted for nothing beyond our own
 * checkout id: PayPal's `subscription_id`, `ba_token` and `token` are ignored, and activation uses the
 * subscription id stored on our row. Every outcome lands on the same success page, so the response is
 * no oracle; the access link only ever goes by email, and the webhook is the backstop if this throws.
 */
export async function GET(request: Request) {
  // Gated on checkout-open (tier AND dataset sharing), unlike the webhook, which gates on the tier flag
  // alone so money already taken is still processed. A buyer arriving here with checkout closed is sent
  // back to the commercial page; the webhook activates them regardless.
  if (!isCommercialCheckoutOpen()) return see(request, COMMERCIAL_PATH);

  const success = `${COMMERCIAL_PATH}/success`;
  const checkout = new URL(request.url).searchParams.get("checkout");
  if (!checkout || !UUID.test(checkout)) return see(request, success);

  try {
    const [row] = await getDb()
      .select({ paypalSubscriptionId: commercialCheckoutsTable.paypalSubscriptionId })
      .from(commercialCheckoutsTable)
      .where(eq(commercialCheckoutsTable.id, checkout))
      .limit(1);
    if (row?.paypalSubscriptionId) {
      // Bounded: the buyer must not hang on PayPal; the webhook is the backstop. A late rejection is
      // logged, never unhandled, and after() keeps the invocation alive for the in-flight activation.
      let timedOut = false;
      const work = activateFromPayPal(row.paypalSubscriptionId).then(
        () => {},
        (err: unknown) => {
          console.error(`checkout-return ${timedOut ? "late activation" : "activation"} failed (${errorCodes(err)})`);
        }
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ACTIVATION_TIMEOUT_MS);
      });
      try {
        if ((await Promise.race([work, timeout])) === "timeout") {
          timedOut = true;
          console.error("checkout-return activation timeout");
          after(() => work);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    console.error(`checkout-return activation failed (${errorCodes(err)})`);
  }
  return see(request, success);
}
