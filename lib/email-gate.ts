import { eq, inArray, sql } from "drizzle-orm";

import { datasetAccessGrantsTable, subscriptionsTable } from "@/lib/db/schema";
import { liveGrant, renewalPendingGrant } from "@/lib/dataset-grants";
import { redactedErrorCode } from "@/lib/db-error";
import { normalizeEmail } from "@/lib/email-address";
import type { SendOutcome } from "@/lib/email";
import {
  CONFIRM_CAP_MAX,
  CONFIRM_CAP_WINDOW_MS,
  DATASET_ADMIN_NOTICE_CAP_MAX,
  DATASET_ADMIN_NOTICE_CAP_WINDOW_MS,
  DATASET_REQUESTER_CAP_KINDS,
  DATASET_REQUESTER_CAP_MAX,
  DATASET_REQUESTER_CAP_WINDOW_MS,
  DATASET_REQUESTER_DAILY_CAP_MAX,
  DATASET_REQUESTER_DAILY_CAP_WINDOW_MS,
  DATASET_SEND_KINDS,
  completeSend,
  countRecentConfirmSends,
  countRecentSends,
  recordSendAttempt,
  recordSkip,
  settleSkip,
  type EmailSendBase,
  type DatasetSendKind,
  type EmailSendKind,
  type EmailSendsDb,
  type SubscriptionSendKind,
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
 *
 * DATASET MAIL has two more doors, mirroring this one (same claim-first order,
 * outcome mapping, never-throws contract and RESIDUAL RACE). `sendGated` itself
 * REFUSES a dataset kind (`skipped_unconfirmed`, recorded): that is a caller bug.
 *
 *   `sendGrantGated` (mail to the requester; rows anchor on the grant, not a
 *   subscription: `subscription_id` null, target `dataset`/grantId). The grant
 *   is re-read BY ID with its `live` and `renewalPending` flags projected in the
 *   same SELECT (strict `=== true`, never a bare `status === "active"`). Gates:
 *   address match; suppression of the grant's own address (global scope for
 *   every kind; `dataset_edition_notice` uses target `dataset_edition`/`weekly`,
 *   which a global row also blocks); required state: `dataset_verify` needs
 *   `unverified`, `dataset_rejected` needs `rejected`, `dataset_already_active`
 *   needs live OR renewal-pending (never lapsed), and approved / link_reissued /
 *   renewal_reminder / edition_notice need live. An edition notice also needs an
 *   `editionId` (row target `dataset_edition`/`<editionId>:<grantId>`). The
 *   requester kinds `dataset_verify` + `dataset_already_active` share ONE
 *   per-address budget with two caps (DATASET_REQUESTER_CAP_*: 5 per hour;
 *   DATASET_REQUESTER_DAILY_CAP_*: 10 per rolling 24 h), each counted AFTER the claim.
 *
 *   `sendDatasetAdminNoticeGated` (maintainer alert, `dataset_admin_new_request`).
 *   The grant must be `pending_review`. NO suppression check: a requester's
 *   opt-out must not hide a request from review. One GLOBAL cap
 *   (DATASET_ADMIN_NOTICE_CAP_*), claim first; a capped request still sits in
 *   the admin queue. An empty recipient sends nothing and writes no row
 *   (`gate_error`: a configuration fault, not a decision about the request).
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

const REQUIRED_STATUS: Record<SubscriptionSendKind, "pending" | "confirmed"> = {
  confirm: "pending",
  watch_started: "confirmed",
  facility_change: "confirmed",
  facility_digest: "confirmed",
  state_digest: "confirmed",
  area_digest: "confirmed",
};

const isDatasetKind = (kind: EmailSendKind): kind is DatasetSendKind =>
  (DATASET_SEND_KINDS as readonly string[]).includes(kind);

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
  kind: SubscriptionSendKind
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

  // Dataset mail has its own gates; reaching this one with a dataset kind is a caller bug. Fail closed.
  const kind = opts.kind;
  if (isDatasetKind(kind)) {
    try {
      await recordSkip(db, { kind, email: opts.email, runId: opts.runId ?? null }, "skipped_unconfirmed");
    } catch (err) {
      logGateError("could not record skip", err);
      return none("gate_error");
    }
    return none("skipped_unconfirmed");
  }

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
    kind
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
    const failures = coveredRows.map((r) => outcomeFor(r, r && statusOf.get(r), opts.email, kind));
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

  if (kind === "confirm") {
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

/** Every dataset kind mailed to the requester (the admin alert has its own gate). */
export type DatasetRequesterKind = Exclude<DatasetSendKind, "dataset_admin_new_request">;

const isRequesterKind = (kind: unknown): kind is DatasetRequesterKind =>
  typeof kind === "string" &&
  kind !== "dataset_admin_new_request" &&
  (DATASET_SEND_KINDS as readonly string[]).includes(kind);

export interface GrantGatedSend {
  kind: DatasetRequesterKind;
  grantId: string;
  /** Plaintext address of the send; must match the grant's, else nothing is sent. */
  email: string;
  /** Required for `dataset_edition_notice`; ignored otherwise. */
  editionId?: string;
  runId?: string | null;
}

/** One claim, then every cap in order (empty = none), then send and settle. Shared by both dataset gates. */
async function claimCountSend(
  db: EmailSendsDb,
  base: EmailSendBase,
  caps: ReadonlyArray<{ count: () => Promise<number>; max: number }>,
  send: () => Promise<SendOutcome>
): Promise<GateResult> {
  const none = (disposition: GateDisposition): GateResult => ({ sent: false, disposition });
  let id: string;
  try {
    id = await recordSendAttempt(db, base);
  } catch (err) {
    logGateError("could not record send attempt", err);
    return none("gate_error");
  }

  for (const cap of caps) {
    let used: number;
    try {
      used = await cap.count();
    } catch (err) {
      logGateError("dataset cap lookup failed", err);
      // Fail closed; the claim stays counted (outcome error), as for confirm.
      await completeSend(db, id, { sent: false, errorCode: "cap_check_failed" });
      return none("gate_error");
    }
    if (used > cap.max) {
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

/** The requester-mail door; see the DATASET MAIL note in the doc comment at the top of this file. */
export async function sendGrantGated(
  db: EmailSendsDb,
  opts: GrantGatedSend,
  send: () => Promise<SendOutcome>
): Promise<GateResult> {
  const none = (disposition: GateDisposition): GateResult => ({ sent: false, disposition });
  const kind: unknown = opts.kind;
  if (!isRequesterKind(kind)) {
    console.error("email gate: sendGrantGated refused a non-requester kind");
    return none("skipped_unconfirmed");
  }

  // (a) Re-read by id; the lifecycle flags are projected in the same SELECT as the row.
  const now = new Date();
  let grant:
    | { id: string; email: string; status: string; live: boolean; renewalPending: boolean }
    | undefined;
  try {
    [grant] = await db
      .select({
        id: datasetAccessGrantsTable.id,
        email: datasetAccessGrantsTable.email,
        status: datasetAccessGrantsTable.status,
        live: sql<boolean>`${liveGrant(now)}`,
        renewalPending: sql<boolean>`${renewalPendingGrant()}`,
      })
      .from(datasetAccessGrantsTable)
      .where(eq(datasetAccessGrantsTable.id, opts.grantId))
      .limit(1);
  } catch (err) {
    logGateError("dataset grant lookup failed", err);
    return none("gate_error");
  }

  const editionId = opts.editionId?.trim() ?? "";
  const base: EmailSendBase = {
    kind,
    email: opts.email,
    subscriptionId: null,
    targetType: kind === "dataset_edition_notice" && editionId ? "dataset_edition" : "dataset",
    targetId: kind === "dataset_edition_notice" && editionId ? `${editionId}:${opts.grantId}` : opts.grantId,
    runId: opts.runId ?? null,
  };
  const skip = async (outcome: SkipOutcome): Promise<GateResult> => {
    try {
      await recordSkip(db, base, outcome);
    } catch (err) {
      logGateError("could not record skip", err);
      return none("gate_error");
    }
    return none(outcome);
  };

  // (b) Gone, or another address.
  if (!grant || normalizeEmail(grant.email) !== normalizeEmail(opts.email)) return skip("skipped_unconfirmed");

  // (c) Suppression of the grant's own address.
  const scope: SuppressionScope =
    kind === "dataset_edition_notice"
      ? { kind: "target", targetType: "dataset_edition", targetId: "weekly" }
      : { kind: "global" };
  const suppression = await isSuppressed(db, grant.email, scope);
  if (!mayEmail(suppression)) return skip(isLookupFailure(suppression) ? "skipped_check_failed" : "skipped_suppressed");

  // (d) Required state. Strict `=== true` on the projected flags: never truthiness, never a bare status check.
  const live = grant.live === true;
  const renewalPending = grant.renewalPending === true;
  let stateOk: boolean;
  switch (kind) {
    case "dataset_verify":
      stateOk = grant.status === "unverified";
      break;
    case "dataset_rejected":
      stateOk = grant.status === "rejected";
      break;
    case "dataset_already_active":
      stateOk = live || renewalPending;
      break;
    default:
      stateOk = live;
  }
  if (!stateOk) return skip("skipped_unconfirmed");

  // (e) An edition notice names its edition.
  if (kind === "dataset_edition_notice" && !editionId) return skip("skipped_unconfirmed");

  // (f) + (g) Claim, count (requester-cap kinds), send.
  const capped = (DATASET_REQUESTER_CAP_KINDS as readonly string[]).includes(kind);
  return claimCountSend(
    db,
    base,
    capped
      ? [
          {
            count: () =>
              countRecentSends(db, {
                kinds: DATASET_REQUESTER_CAP_KINDS,
                email: grant.email,
                windowMs: DATASET_REQUESTER_CAP_WINDOW_MS,
              }),
            max: DATASET_REQUESTER_CAP_MAX,
          },
          {
            count: () =>
              countRecentSends(db, {
                kinds: DATASET_REQUESTER_CAP_KINDS,
                email: grant.email,
                windowMs: DATASET_REQUESTER_DAILY_CAP_WINDOW_MS,
              }),
            max: DATASET_REQUESTER_DAILY_CAP_MAX,
          },
        ]
      : [],
    send
  );
}

/** The maintainer-alert door; see the DATASET MAIL note in the doc comment at the top of this file. */
export async function sendDatasetAdminNoticeGated(
  db: EmailSendsDb,
  opts: { grantId: string; recipient: string },
  send: () => Promise<SendOutcome>
): Promise<GateResult> {
  const none = (disposition: GateDisposition): GateResult => ({ sent: false, disposition });
  const recipient = opts.recipient.trim();
  if (!recipient) {
    console.error("email gate: dataset admin notice has no recipient");
    return none("gate_error");
  }

  let grant: { status: string } | undefined;
  try {
    [grant] = await db
      .select({ status: datasetAccessGrantsTable.status })
      .from(datasetAccessGrantsTable)
      .where(eq(datasetAccessGrantsTable.id, opts.grantId))
      .limit(1);
  } catch (err) {
    logGateError("dataset grant lookup failed", err);
    return none("gate_error");
  }

  const base: EmailSendBase = {
    kind: "dataset_admin_new_request",
    email: recipient,
    subscriptionId: null,
    targetType: "dataset",
    targetId: opts.grantId,
  };
  if (grant?.status !== "pending_review") {
    try {
      await recordSkip(db, base, "skipped_unconfirmed");
    } catch (err) {
      logGateError("could not record skip", err);
      return none("gate_error");
    }
    return none("skipped_unconfirmed");
  }

  return claimCountSend(
    db,
    base,
    [
      {
        count: () =>
          countRecentSends(db, { kinds: ["dataset_admin_new_request"], windowMs: DATASET_ADMIN_NOTICE_CAP_WINDOW_MS }),
        max: DATASET_ADMIN_NOTICE_CAP_MAX,
      },
    ],
    send
  );
}
