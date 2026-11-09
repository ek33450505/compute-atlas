import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import { DATASET_TOKEN_RE } from "@/lib/dataset-grants";
import { suppress } from "@/lib/suppressions";
import { hashToken } from "@/lib/token-hash";

/**
 * The suppression scope the weekly edition notice is gated on (lib/email-gate.ts:
 * `dataset_edition_notice` checks target `dataset_edition`/`weekly`). One constant
 * here so the unsubscribe write and the gate's read cannot drift apart silently;
 * the gate integration test in lib/dataset-unsubscribe.integration.test.ts pins them.
 */
export const DATASET_NOTICE_SCOPE = {
  kind: "target",
  targetType: "dataset_edition",
  targetId: "weekly",
} as const;

/**
 * One-click / interstitial unsubscribe from the weekly dataset edition notice.
 *
 * `unsubscribed` and `invalid` are for the CALLER's bookkeeping and tests only: the
 * route must answer both identically, so a probe cannot enumerate tokens. The raw
 * token is matched on `unsubscribe_token` (stored raw by the subscriptions
 * precedent: its blast radius is unsubscribe-only) and works for a grant in ANY
 * status, so a revoked or expired holder can still stop the mail.
 *
 * This writes only an `email_suppressions` row. It does NOT touch the grant: the
 * personal access link keeps working, only the weekly notice stops. Idempotent
 * (`suppress` ignores a repeat).
 *
 * A malformed token returns `invalid` BEFORE any DB call. A DB failure throws; the
 * caller logs `redactedErrorCode` only (the error can embed the address).
 */
export async function unsubscribeDatasetNotices(
  rawToken: string
): Promise<{ outcome: "unsubscribed" } | { outcome: "invalid" }> {
  if (!DATASET_TOKEN_RE.test(rawToken)) return { outcome: "invalid" };

  const db = getDb();
  const [grant] = await db
    .select({ email: datasetAccessGrantsTable.email })
    .from(datasetAccessGrantsTable)
    .where(eq(datasetAccessGrantsTable.unsubscribeToken, rawToken))
    .limit(1);
  if (!grant) return { outcome: "invalid" };

  await suppress(db, grant.email, DATASET_NOTICE_SCOPE, "unsubscribe", hashToken(rawToken));
  return { outcome: "unsubscribed" };
}
