import { eq } from "drizzle-orm";

import { subscriptionsTable } from "@/lib/db/schema";
import { redactedErrorCode } from "@/lib/db-error";
import { normalizeEmail } from "@/lib/email-address";
import type { SendOutcome } from "@/lib/email";
import {
  CONFIRM_CAP_MAX,
  CONFIRM_CAP_WINDOW_MS,
  completeSend,
  countRecentConfirmSends,
  recordSendAttempt,
  recordSkip,
  settleSkip,
  type EmailSendBase,
  type EmailSendKind,
  type EmailSendsDb,
} from "@/lib/email-sends";
import { isLookupFailure, isSuppressed, mayEmail, type SuppressionScope } from "@/lib/suppressions";

/**
 * The one door every subscription email goes through. A sender is handed to
 * `sendGated` as a callback and is only invoked once ALL of these hold:
 *
 *   1. The subscription row, re-read BY ID, still exists for this address.
 *      The caller's idea of its status is never trusted: `after()` runs
 *      after the response, so the row may have been unsubscribed meanwhile.
 *   2. `mayEmail(isSuppressed(...))` for the row's own scope (a target row
 *      is also blocked by a global suppression; the retired `all` target or
 *      a null target id maps to global). "unknown" is a no-send.
 *   3. The row is in the state the kind requires: `pending` for `confirm`,
 *      `confirmed` for everything else.
 *   4. For `confirm`, the per-address cap holds. CLAIM FIRST: the `attempted`
 *      row is inserted and THEN counted (the count includes the claim), so
 *      concurrent confirms each see the others' claims. Count-then-insert
 *      would let N concurrent requests all read a count under the cap.
 *   5. The `attempted` row was written. A failure here is fail-closed: no
 *      row means no accountability, so no mail.
 *
 * Outcome mapping (all rows land in `email_sends`):
 *   suppressed                              -> skipped_suppressed
 *   suppression lookup errored ("unknown")  -> skipped_check_failed
 *   row missing / address mismatch / wrong state -> skipped_unconfirmed
 *   over the confirm cap (claim settled)    -> skipped_capped
 *   sender ok / no key / failed or threw    -> sent / skipped_no_key / error
 * The returned `disposition` mirrors the row (`error` is `send_failed`).
 * `gate_error` means a DB error stopped the gate and nothing was sent. It
 * leaves no row, except a cap-lookup failure, which leaves its claim settled
 * as `error` / `cap_check_failed` (still counted toward the cap).
 *
 * `skipped_unconfirmed` is the one outcome for "the subscription is not in
 * the state this mail requires". A confirmed row asked for a confirm mail
 * lands there too: no new outcome value was added, because that would need a
 * schema change for a case that is a caller bug.
 *
 * RESIDUAL RACE (accepted): a confirm, unsubscribe or new suppression that
 * lands after the gate's reads but before `send()` returns is not seen. The
 * window is one claim insert + the cap count + the Resend round trip.
 *
 * PLUS-ADDRESSING: `a+1@x` and `a+2@x` are different addresses here and get
 * separate confirm caps, by design. Stripping the `+tag` would be wrong for
 * providers where it is a distinct mailbox; the per-IP 5/hour subscribe
 * limit still bounds how many such confirms one client can trigger.
 *
 * NEVER throws for DB errors; the HTTP response must not depend on the
 * outcome (capped, suppressed and DB-down look identical to the requester),
 * so callers inside `after()` only need the result for tests and logs.
 */

export type GateDisposition =
  | "sent"
  | "send_failed"
  | "skipped_suppressed"
  | "skipped_check_failed"
  | "skipped_unconfirmed"
  | "skipped_capped"
  /** The sender reported no API key: nothing was mailed (row `skipped_no_key`). */
  | "skipped_no_key"
  /** The gate could not decide or record (DB error): nothing was sent. */
  | "gate_error";

export interface GateResult {
  /** True only when the sender reported `sent: true`. */
  sent: boolean;
  disposition: GateDisposition;
}

export interface GatedSend {
  kind: EmailSendKind;
  subscriptionId: string;
  /** Plaintext address of the send; must match the row's, else nothing is sent. */
  email: string;
  runId?: string | null;
}

const REQUIRED_STATUS: Record<EmailSendKind, "pending" | "confirmed"> = {
  confirm: "pending",
  watch_started: "confirmed",
  facility_change: "confirmed",
  facility_digest: "confirmed",
  state_digest: "confirmed",
  area_digest: "confirmed",
};

function scopeForRow(row: { targetType: string; targetId: string | null }): SuppressionScope {
  if (row.targetType === "all" || !row.targetId) return { kind: "global" };
  return { kind: "target", targetType: row.targetType, targetId: row.targetId };
}

function logGateError(what: string, err: unknown): void {
  console.error(`email gate: ${what} (sqlstate: ${redactedErrorCode(err)})`);
}

export async function sendGated(
  db: EmailSendsDb,
  opts: GatedSend,
  send: () => Promise<SendOutcome>
): Promise<GateResult> {
  const none = (disposition: GateDisposition): GateResult => ({ sent: false, disposition });

  // 1. Re-read the row by id.
  let row: typeof subscriptionsTable.$inferSelect | undefined;
  try {
    [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, opts.subscriptionId)).limit(1);
  } catch (err) {
    logGateError("subscription lookup failed", err);
    return none("gate_error");
  }

  const base: EmailSendBase = {
    kind: opts.kind,
    email: opts.email,
    subscriptionId: row ? row.id : null, // the FK would reject a vanished id
    targetType: row?.targetType ?? null,
    targetId: row?.targetId ?? null,
    runId: opts.runId ?? null,
  };

  const skip = async (
    outcome: "skipped_suppressed" | "skipped_check_failed" | "skipped_unconfirmed"
  ): Promise<GateResult> => {
    try {
      await recordSkip(db, base, outcome);
    } catch (err) {
      logGateError("could not record skip", err);
      return none("gate_error");
    }
    return none(outcome);
  };

  if (!row || normalizeEmail(row.email) !== normalizeEmail(opts.email)) {
    return skip("skipped_unconfirmed");
  }

  // 2. Suppression, from the row's own scope.
  const suppression = await isSuppressed(db, row.email, scopeForRow(row));
  if (!mayEmail(suppression)) {
    return skip(isLookupFailure(suppression) ? "skipped_check_failed" : "skipped_suppressed");
  }

  // 3. State the kind requires.
  if (row.status !== REQUIRED_STATUS[opts.kind]) {
    return skip("skipped_unconfirmed");
  }

  // 4 + 5. Claim a send slot; for confirm, count including the claim.
  let id: string;
  try {
    id = await recordSendAttempt(db, base);
  } catch (err) {
    logGateError("could not record send attempt", err);
    return none("gate_error");
  }

  if (opts.kind === "confirm") {
    let used: number;
    try {
      used = await countRecentConfirmSends(db, row.email, CONFIRM_CAP_WINDOW_MS);
    } catch (err) {
      logGateError("confirm cap lookup failed", err);
      // Fail closed. The claim stays counted (outcome error) so a flapping DB cannot be used to exceed the cap.
      await completeSend(db, id, { sent: false, errorCode: "cap_check_failed" });
      return none("gate_error");
    }
    if (used > CONFIRM_CAP_MAX) {
      await settleSkip(db, id, "skipped_capped");
      return none("skipped_capped");
    }
  }

  let outcome: SendOutcome;
  try {
    outcome = await send();
  } catch {
    outcome = { sent: false, errorCode: "send_threw" };
  }
  await completeSend(db, id, outcome);
  if (outcome.sent) return { sent: true, disposition: "sent" };
  return none("skipped" in outcome && outcome.skipped === "no_key" ? "skipped_no_key" : "send_failed");
}
