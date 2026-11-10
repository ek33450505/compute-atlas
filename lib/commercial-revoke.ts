import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { getDb } from "@/lib/db/client";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import { redactedErrorCode } from "@/lib/db-error";
import { getStripeClient } from "@/lib/stripe";

/**
 * Admin revoke of a COMMERCIAL grant also stops its billing: the Stripe subscription is cancelled at once.
 * Never a refund (the maintainer refunds by hand in Stripe, if at all). The caller revokes in the DB FIRST, so
 * a failed cancel is still covered by the webhook backstop (`revoked_still_billing` in
 * lib/commercial-grants.ts cancels on the next payment event) and the admin is told to cancel by hand.
 *
 * Idempotent: the Stripe call carries a key derived from the grant id, and an already-canceled subscription
 * counts as done (checked by reading it back). Logs a code only, never an id, address or error message.
 */

export type RevokeCancelOutcome =
  | { cancelled: true }
  | { cancelled: false; reason: "not_commercial" | "no_subscription" | "stripe_error" | "lookup_failed" };

export interface RevokeCancelDeps {
  db?: Pick<ReturnType<typeof getDb>, "select">;
  stripe?: Pick<Stripe, "subscriptions">;
}

export async function cancelSubscriptionForRevokedGrant(
  grantId: string,
  deps: RevokeCancelDeps = {}
): Promise<RevokeCancelOutcome> {
  let grant: { status: string; tier: string; stripeSubscriptionId: string | null } | undefined;
  try {
    const db = deps.db ?? getDb();
    [grant] = await db
      .select({
        status: datasetAccessGrantsTable.status,
        tier: datasetAccessGrantsTable.tier,
        stripeSubscriptionId: datasetAccessGrantsTable.stripeSubscriptionId,
      })
      .from(datasetAccessGrantsTable)
      .where(eq(datasetAccessGrantsTable.id, grantId))
      .limit(1);
  } catch (err) {
    console.error(`cancelSubscriptionForRevokedGrant lookup failed (code: ${redactedErrorCode(err)})`);
    return { cancelled: false, reason: "lookup_failed" };
  }
  if (!grant || grant.status !== "revoked" || grant.tier !== "commercial") {
    return { cancelled: false, reason: "not_commercial" };
  }
  const subscriptionId = grant.stripeSubscriptionId;
  if (!subscriptionId) return { cancelled: false, reason: "no_subscription" };

  try {
    const stripe = deps.stripe ?? getStripeClient();
    try {
      await stripe.subscriptions.cancel(subscriptionId, {}, { idempotencyKey: `ca-admin-revoke-${grantId}` });
    } catch (err) {
      const current = await stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
      if (current?.status !== "canceled") throw err;
    }
    return { cancelled: true };
  } catch (err) {
    console.error(`cancelSubscriptionForRevokedGrant failed (code: ${redactedErrorCode(err)})`);
    return { cancelled: false, reason: "stripe_error" };
  }
}
