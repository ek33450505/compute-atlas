/**
 * "Email me when this is reviewed" — a one-shot notify request against a
 * single pending `submissions` row. See the `submissionNotifyRequestsTable`
 * doc comment in lib/db/schema.ts for why this is NOT a subscription (no
 * ongoing relationship, no token, no unsubscribe).
 *
 * This module owns the table's CRUD only. It does not send email and does
 * not decide whether the feature is on for a given request beyond exposing
 * the flag check itself — callers (the intake in lib/contribute.ts, the
 * review-time send in lib/submissions.ts) own that decision.
 *
 * INVARIANT: no function here ever logs a caught error object. Drizzle wraps
 * driver errors in `DrizzleQueryError`, whose own `.message` is
 * `Failed query: ${query}\nparams: ${params}` — so logging that object logs
 * the bound email address (a real prior incident here did exactly this with
 * an IP hash). Only `recordSubmissionNotifyRequest`'s insert binds the email
 * in a statement that can throw; it is handled by rethrowing (never logging)
 * for anything that isn't a unique violation, leaving the redaction decision
 * to callers that catch further up (see lib/contribute.ts).
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { submissionNotifyRequestsTable } from "@/lib/db/schema";

/**
 * Read at CALL time, never cached at module scope — env vars can change
 * between requests in a serverless runtime and a module-scope read would
 * freeze whatever value was present at cold start. Same rationale as
 * `getResend()` in lib/email.ts.
 */
export function submissionNotifyEnabled(): boolean {
  return process.env.SUBMISSION_NOTIFY_ENABLED === "true";
}

/**
 * Records a request to be notified when `submissionId` is reviewed. `email`
 * must already be lowercased + trimmed by the caller — this function does
 * not normalize it.
 *
 * A unique-violation on `submissionId` (a second request for the same
 * submission) is treated as a no-op, not an error: the intent — "tell me
 * when this is reviewed" — is already satisfied by the existing row.
 */
export async function recordSubmissionNotifyRequest(
  submissionId: string,
  email: string
): Promise<void> {
  try {
    await getDb().insert(submissionNotifyRequestsTable).values({ submissionId, email });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return;
    }
    throw err;
  }
}

/**
 * Looks up the notify request for `submissionId`, if any. Named `get`, not
 * `take`, deliberately: it does NOT delete the row — the caller decides when
 * to delete, because a failed send must still delete it (see the module doc
 * comment on this file and lib/submissions.ts's review path). A `take*` name
 * would imply consuming/removing, which this does not do.
 */
export async function getSubmissionNotifyRequest(
  submissionId: string
): Promise<{ email: string } | null> {
  const rows = await getDb()
    .select({ email: submissionNotifyRequestsTable.email })
    .from(submissionNotifyRequestsTable)
    .where(eq(submissionNotifyRequestsTable.submissionId, submissionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Idempotent delete by `submissionId`. Safe to call whether or not a row
 * exists (e.g. no notify request was ever made for this submission).
 */
export async function deleteSubmissionNotifyRequest(submissionId: string): Promise<void> {
  await getDb()
    .delete(submissionNotifyRequestsTable)
    .where(eq(submissionNotifyRequestsTable.submissionId, submissionId));
}

const UNIQUE_VIOLATION_CODE = "23505";

/**
 * Exact duplicate of lib/subscribe.ts's `isUniqueViolation` (same reasoning:
 * both the neon-http and PGlite drivers surface constraint violations with a
 * Postgres error `code`, but drizzle-orm wraps the driver error in a
 * `DrizzleQueryError` whose own `.message` is a generic "Failed query: ..."
 * string — the real `code`/message live one level down on `.cause`, plus a
 * message-regex fallback in case a driver loses `code`). Duplicated rather
 * than imported because this module has no other dependency on
 * lib/subscribe.ts and the predicate is small and stable — keep the two in
 * sync if the shared shape ever changes.
 */
function isUniqueViolation(err: unknown): boolean {
  const layers = [err, err instanceof Error ? err.cause : undefined];
  return layers.some((layer) => {
    if (!layer) return false;
    if ((layer as { code?: unknown }).code === UNIQUE_VIOLATION_CODE) return true;
    const message = layer instanceof Error ? layer.message : String(layer);
    return /duplicate key|unique/i.test(message);
  });
}
