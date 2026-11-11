import { and, eq, isNotNull } from "drizzle-orm";

import { redactedErrorCode } from "@/lib/db-error";
import { getDb } from "@/lib/db/client";
import { DATASET_TOKEN_RE, liveGrant } from "@/lib/dataset-grants";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import { cancelSubscription, PayPalApiError, PayPalConfigError } from "@/lib/paypal";
import { hashToken } from "@/lib/token-hash";

export const SUBSCRIBER_CANCEL_REASON = "Cancelled by subscriber";

export type CancelResult = { ok: true; paidThrough: Date } | { ok: false };

type CancelDb = Pick<ReturnType<typeof getDb>, "select">;

/**
 * A subscriber cancels their own PayPal subscription. Eligible only: a LIVE commercial grant (so not
 * revoked, expired or lapsed) that has a PayPal subscription id. Anything else is the same `{ ok: false }`,
 * so the caller cannot tell an unknown token from an ineligible grant. Access is NOT cut: `paid_through`
 * is left alone and the grant runs out on its own. Logs codes only, never the token, id or error object.
 */
export async function cancelOwnSubscription(
  rawToken: string,
  deps: { db?: CancelDb; now?: Date } = {}
): Promise<CancelResult> {
  if (!DATASET_TOKEN_RE.test(rawToken)) return { ok: false };

  let subscriptionId: string;
  let paidThrough: Date;
  try {
    const [row] = await (deps.db ?? getDb())
      .select({
        subscriptionId: datasetAccessGrantsTable.paypalSubscriptionId,
        paidThrough: datasetAccessGrantsTable.paidThrough,
      })
      .from(datasetAccessGrantsTable)
      .where(
        and(
          eq(datasetAccessGrantsTable.accessTokenHash, hashToken(rawToken)),
          eq(datasetAccessGrantsTable.tier, "commercial"),
          isNotNull(datasetAccessGrantsTable.paypalSubscriptionId),
          liveGrant(deps.now ?? new Date())
        )
      )
      .limit(1);
    // liveGrant already implies a future paid_through for commercial; the checks narrow the types.
    if (!row?.subscriptionId || !row.paidThrough) return { ok: false };
    subscriptionId = row.subscriptionId;
    paidThrough = row.paidThrough;
  } catch (err) {
    console.error(`commercial-cancel lookup failed (sqlstate: ${redactedErrorCode(err)})`);
    return { ok: false };
  }

  try {
    await cancelSubscription(subscriptionId, SUBSCRIBER_CANCEL_REASON);
  } catch (err) {
    const code = err instanceof PayPalConfigError ? "config" : err instanceof PayPalApiError ? "paypal" : "unknown";
    console.error(`commercial-cancel paypal call failed (code: ${code})`);
    return { ok: false };
  }
  return { ok: true, paidThrough };
}
