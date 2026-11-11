import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import { redactedErrorCode } from "@/lib/db-error";
import { cancelSubscription, PayPalConfigError } from "@/lib/paypal";

/**
 * Admin revoke of a COMMERCIAL grant also stops its billing: the PayPal subscription is cancelled at once.
 * Never a refund (the maintainer refunds by hand in PayPal, if at all). The caller revokes in the DB FIRST, so
 * a failed cancel leaves the grant revoked and the admin is told to cancel the subscription by hand.
 *
 * Idempotent: an already-inactive subscription counts as done (`alreadyInactive`). Logs a code only, never an
 * id, address or error message.
 */

export type RevokeCancelOutcome =
  | { cancelled: true }
  | { cancelled: false; reason: "not_commercial" | "no_subscription" | "provider_error" | "lookup_failed" };

export interface RevokeCancelDeps {
  db?: Pick<ReturnType<typeof getDb>, "select">;
}

export async function cancelSubscriptionForRevokedGrant(
  grantId: string,
  deps: RevokeCancelDeps = {}
): Promise<RevokeCancelOutcome> {
  let grant: { status: string; tier: string; paypalSubscriptionId: string | null } | undefined;
  try {
    const db = deps.db ?? getDb();
    [grant] = await db
      .select({
        status: datasetAccessGrantsTable.status,
        tier: datasetAccessGrantsTable.tier,
        paypalSubscriptionId: datasetAccessGrantsTable.paypalSubscriptionId,
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
  const subscriptionId = grant.paypalSubscriptionId;
  if (!subscriptionId) return { cancelled: false, reason: "no_subscription" };

  try {
    await cancelSubscription(subscriptionId, "Access revoked by Compute Atlas");
    return { cancelled: true };
  } catch (err) {
    const code = err instanceof PayPalConfigError ? "config" : redactedErrorCode(err);
    console.error(`cancelSubscriptionForRevokedGrant failed (code: ${code})`);
    return { cancelled: false, reason: "provider_error" };
  }
}
