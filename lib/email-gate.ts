import { eq, inArray } from "drizzle-orm";

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
import { isLookupFailure, isSuppressed, mayEmail, suppressionStatuses, type SuppressionScope, type SuppressionStatus } from "@/lib/suppressions";

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
 *      A multi-row email (a facility digest) lists several watches.
 *      `coveredSubscriptionIds` names every row the email lists; each is
 *      re-read in ONE query and must pass checks 1-3 on its own (exists, same
 *      address, own-scope suppression, required status) or the WHOLE email is
 *      skipped, because a digest that still lists a watch the reader just
 *      left is the "opt-out not final" defect. Covered rows' suppression is
 *      ONE query for the address (`suppressionStatuses`), not one per row.
 *      Exactly one `email_sends` row per email, recorded as follows:
 *        (a) The anchor (`subscriptionId`) is checked first. If it fails the
 *            row is anchored on it.
 *        (b) If the anchor passes and a covered row fails, the outcome is
 *            the most severe covered failure (check_failed > suppressed >
 *            unconfirmed) and the row references the FIRST covered row with
 *            that outcome: its `subscription_id` (null if it vanished),
 *            `target_type` and `target_id`, plus `error_code = "covered_row"`
 *            so an auditor can tell a covered failure from an anchor one.
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
  /**
   * Every subscription row a multi-row email lists (include the anchor or
   * not; it is checked either way). All must pass or nothing is sent.
   */
  coveredSubscriptionIds?: string[];
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

type SubscriptionRow = typeof subscriptionsTable.$inferSelect;
type SkipOutcome = "skipped_suppressed" | "skipped_check_failed" | "skipped_unconfirmed";

/**
 * The one predicate for checks 1-3 on an already-read row, given its
 * suppression status (looked up by the caller, singly or batched). Pure; null
 * means the row may be mailed. An absent row, or one that belongs to another
 * address, is unconfirmed before any suppression status is consulted.
 */
function outcomeFor(
  row: SubscriptionRow | undefined,
  suppression: SuppressionStatus | undefined,
  email: string,
  kind: EmailSendKind
): SkipOutcome | null {
  if (!row || suppression === undefined || normalizeEmail(row.email) !== normalizeEmail(email)) {
    return "skipped_unconfirmed";
  }
  if (!mayEmail(suppression)) return isLookupFailure(suppression) ? "skipped_check_failed" : "skipped_suppressed";
  if (row.status !== REQUIRED_STATUS[kind]) return "skipped_unconfirmed";
  return null;
}

const SKIP_SEVERITY: SkipOutcome[] = ["skipped_check_failed", "skipped_suppressed", "skipped_unconfirmed"];

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
  let row: SubscriptionRow | undefined;
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

  // `covered` set => the failing row is a covered one (undefined row = it vanished).
  const skip = async (
    outcome: SkipOutcome,
    covered?: { row: SubscriptionRow | undefined }
  ): Promise<GateResult> => {
    try {
      if (covered) {
        const coveredBase: EmailSendBase = {
          ...base,
          subscriptionId: covered.row?.id ?? null,
          targetType: covered.row?.targetType ?? null,
          targetId: covered.row?.targetId ?? null,
        };
        await recordSkip(db, coveredBase, outcome, "covered_row");
      } else {
        await recordSkip(db, base, outcome);
      }
    } catch (err) {
      logGateError("could not record skip", err);
      return none("gate_error");
    }
    return none(outcome);
  };

  // 2 + 3. Address, suppression from the row's own scope, required state.
  const anchorSkip = outcomeFor(
    row,
    row && normalizeEmail(row.email) === normalizeEmail(opts.email)
      ? await isSuppressed(db, row.email, scopeForRow(row))
      : undefined,
    opts.email,
    opts.kind
  );
  if (anchorSkip) return skip(anchorSkip);

  // Every other row a multi-row email lists, in one query.
  const coveredIds = [...new Set(opts.coveredSubscriptionIds ?? [])].filter((id) => id !== opts.subscriptionId);
  if (coveredIds.length > 0) {
    let covered: SubscriptionRow[];
    try {
      covered = await db.select().from(subscriptionsTable).where(inArray(subscriptionsTable.id, coveredIds));
    } catch (err) {
      logGateError("covered subscription lookup failed", err);
      return none("gate_error");
    }
    const byId = new Map(covered.map((r) => [r.id, r]));
    const coveredRows = coveredIds.map((id) => byId.get(id));
    // Address first (a row that is gone or belongs to someone else is
    // unconfirmed), then ONE suppression query for every remaining row's scope.
    const present = coveredRows.filter(
      (r): r is SubscriptionRow => !!r && normalizeEmail(r.email) === normalizeEmail(opts.email)
    );
    const statuses = await suppressionStatuses(db, opts.email, present.map(scopeForRow));
    const statusOf = new Map(present.map((r, i) => [r, statuses[i]]));
    const failures = coveredRows.map((r) => outcomeFor(r, r && statusOf.get(r), opts.email, opts.kind));
    const worst = SKIP_SEVERITY.find((o) => failures.includes(o));
    if (worst) return skip(worst, { row: coveredRows[failures.indexOf(worst)] });
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
