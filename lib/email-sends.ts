import { and, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";
import { emailSendsTable } from "@/lib/db/schema";
import { redactedErrorCode } from "@/lib/db-error";
import { normalizeEmail } from "@/lib/email-address";
import { safeErrorCode, type SendOutcome } from "@/lib/email";
import { hashNotifyEmail } from "@/lib/rate-limit";

/**
 * Write path for the `email_sends` accountability log (see
 * `emailSendsTable`'s doc comment in lib/db/schema.ts). It records what was
 * mailed and how it ended; it is NOT a dedupe ledger and nothing here
 * decides whether to send. The caller (lib/email-gate.ts) owns the
 * fail-closed policy.
 */

/** Subscription mail, gated by `sendGated` (lib/email-gate.ts). */
export const SUBSCRIPTION_SEND_KINDS = [
  "confirm",
  "watch_started",
  "facility_change",
  "facility_digest",
  "state_digest",
  "area_digest",
] as const;
export type SubscriptionSendKind = (typeof SUBSCRIPTION_SEND_KINDS)[number];

/** Dataset-sharing mail, gated by `sendGrantGated` / `sendDatasetAdminNoticeGated`; never by `sendGated`. */
export const DATASET_SEND_KINDS = [
  "dataset_verify",
  "dataset_already_active",
  "dataset_admin_new_request",
  "dataset_approved",
  "dataset_rejected",
  "dataset_commercial_redirect",
  "dataset_edition_notice",
  "dataset_renewal_reminder",
  "dataset_link_reissued",
] as const;
export type DatasetSendKind = (typeof DATASET_SEND_KINDS)[number];

export const EMAIL_SEND_KINDS = [...SUBSCRIPTION_SEND_KINDS, ...DATASET_SEND_KINDS] as const;
export type EmailSendKind = (typeof EMAIL_SEND_KINDS)[number];

export const EMAIL_SEND_SKIP_OUTCOMES = [
  "skipped_suppressed",
  "skipped_unconfirmed",
  "skipped_capped",
  /** The suppression lookup errored ("unknown"): not sent, but NOT a suppression. `outcome` is a plain text column, so no migration. */
  "skipped_check_failed",
] as const;
export type EmailSendSkipOutcome = (typeof EMAIL_SEND_SKIP_OUTCOMES)[number];

export const EMAIL_SEND_OUTCOMES = [
  "attempted",
  "sent",
  "error",
  "skipped_no_key",
  ...EMAIL_SEND_SKIP_OUTCOMES,
] as const;
export type EmailSendOutcome = (typeof EMAIL_SEND_OUTCOMES)[number];

/** Per-address cap on `confirm` sends: CONFIRM_CAP_MAX per CONFIRM_CAP_WINDOW_MS (Ed, 10 per 30 days). */
export const CONFIRM_CAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const CONFIRM_CAP_MAX = 10;

/**
 * Requester-facing dataset mail that spends ONE shared per-address budget, with two caps (Ed, 2026-11-09):
 * DATASET_REQUESTER_CAP_MAX per DATASET_REQUESTER_CAP_WINDOW_MS (5 per address per hour) AND
 * DATASET_REQUESTER_DAILY_CAP_MAX per DATASET_REQUESTER_DAILY_CAP_WINDOW_MS (10 per address per rolling 24 h).
 */
export const DATASET_REQUESTER_CAP_KINDS: readonly DatasetSendKind[] = ["dataset_verify", "dataset_already_active"];
export const DATASET_REQUESTER_CAP_MAX = 5;
export const DATASET_REQUESTER_CAP_WINDOW_MS = 60 * 60 * 1000;

/**
 * The daily cap counts the same kinds, shares the same budget across them, and is counted after the claim.
 * Accepted trade-off (Ed, 2026-11-09): a stranger who keeps re-requesting an owner's address (one rotation
 * per 20 minutes) uses up the daily budget in about 3 hours, and the owner's own verify mail is then refused
 * for the rest of that 24 h window.
 */
export const DATASET_REQUESTER_DAILY_CAP_MAX = 10;
export const DATASET_REQUESTER_DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Maintainer new-request alerts: DATASET_ADMIN_NOTICE_CAP_MAX per rolling 24 h across ALL requests (Ed, 2026-11-09). */
export const DATASET_ADMIN_NOTICE_CAP_MAX = 25;
export const DATASET_ADMIN_NOTICE_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Any drizzle pg database (neon-http in prod, PGlite in tests); same shape as `SuppressionDb`. */
export type EmailSendsDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface EmailSendBase {
  kind: EmailSendKind;
  /** Plaintext address; hashed here and never stored. */
  email: string;
  subscriptionId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  runId?: string | null;
}

/** `hashNotifyEmail` needs a pre-normalised address; every hash here goes through this so case/padding variants of one address share one hash. */
export function hashAddress(email: string): string {
  return hashNotifyEmail(normalizeEmail(email));
}

/**
 * False when `CONTRIBUTE_IP_SALT` is unset or empty. `hashAddress` then falls
 * back to the repo-public default salt, so a lookup by hash would match
 * nothing for a real production address and say nothing about why. Address
 * lookups must check this and refuse rather than answer wrongly.
 */
export function addressLookupAvailable(): boolean {
  return Boolean(process.env.CONTRIBUTE_IP_SALT);
}

function baseValues(base: EmailSendBase) {
  return {
    kind: base.kind,
    emailHash: hashAddress(base.email),
    subscriptionId: base.subscriptionId ?? null,
    targetType: base.targetType ?? null,
    targetId: base.targetId ?? null,
    runId: base.runId ?? null,
  };
}

/** Inserts an `attempted` row and returns its id. THROWS on DB error. */
export async function recordSendAttempt(db: EmailSendsDb, base: EmailSendBase): Promise<string> {
  const [row] = await db
    .insert(emailSendsTable)
    .values(baseValues(base))
    .returning({ id: emailSendsTable.id });
  return row.id;
}

/**
 * Settles an attempt from the sender's result. NEVER throws: the mail has
 * already left, so a failed UPDATE is logged (SQLSTATE only) and dropped.
 */
export async function completeSend(db: EmailSendsDb, id: string, outcome: SendOutcome): Promise<void> {
  try {
    let patch: { outcome: EmailSendOutcome; resendId: string | null; errorCode: string | null };
    if (outcome.sent) {
      patch = { outcome: "sent", resendId: outcome.resendId, errorCode: null };
    } else if ("skipped" in outcome && outcome.skipped === "no_key") {
      patch = { outcome: "skipped_no_key", resendId: null, errorCode: null };
    } else {
      patch = {
        outcome: "error",
        resendId: null,
        errorCode: "errorCode" in outcome ? safeErrorCode(outcome.errorCode) : "refused",
      };
    }
    await db
      .update(emailSendsTable)
      .set({ ...patch, completedAt: new Date() })
      .where(eq(emailSendsTable.id, id));
  } catch (err) {
    console.warn(`email_sends: could not record send outcome (${redactedErrorCode(err)})`);
  }
}

/** Inserts an already-completed skip row. THROWS on DB error. `errorCode` is a fixed identifier (never free text). */
export async function recordSkip(
  db: EmailSendsDb,
  base: EmailSendBase,
  outcome: EmailSendSkipOutcome,
  errorCode?: string
): Promise<void> {
  await db
    .insert(emailSendsTable)
    .values({ ...baseValues(base), outcome, completedAt: new Date(), ...(errorCode ? { errorCode } : {}) });
}

/**
 * Settles a claimed `attempted` row as a skip (the send gate claims before it
 * counts, so an over-cap claim is converted here). NEVER throws: if the
 * UPDATE fails the row stays `attempted`, which over-counts toward the cap
 * (safe) and is logged, SQLSTATE only.
 */
export async function settleSkip(db: EmailSendsDb, id: string, outcome: EmailSendSkipOutcome): Promise<void> {
  try {
    await db
      .update(emailSendsTable)
      .set({ outcome, completedAt: new Date() })
      .where(eq(emailSendsTable.id, id));
  } catch (err) {
    console.warn(`email_sends: could not settle skip (${redactedErrorCode(err)})`);
  }
}

/**
 * Counts `confirm` rows for the address since `now - windowMs`, excluding
 * every `skipped_*` outcome, `skipped_no_key` included (a skipped send mailed nothing, so it must not spend
 * the budget). `attempted` and `error` DO count: a send that may have gone
 * out is spent. THROWS on DB error.
 *
 * RACE: count-then-send is check-then-act, so concurrent confirms can each
 * read a count under the cap and all send, overshooting it. This reader
 * cannot close that. The send gate (lib/email-gate.ts) claims first (inserts the `attempted` row, then
 * counts including it) so the count sees its own claim.
 */
export async function countRecentConfirmSends(
  db: EmailSendsDb,
  email: string,
  windowMs: number = CONFIRM_CAP_WINDOW_MS,
  now: Date = new Date()
): Promise<number> {
  const since = new Date(now.getTime() - windowMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSendsTable)
    .where(
      and(
        eq(emailSendsTable.kind, "confirm"),
        eq(emailSendsTable.emailHash, hashAddress(email)),
        gte(emailSendsTable.createdAt, since),
        notInArray(emailSendsTable.outcome, ["skipped_no_key", ...EMAIL_SEND_SKIP_OUTCOMES])
      )
    );
  return row?.n ?? 0;
}

/**
 * Kind-parameterized sibling of `countRecentConfirmSends`: counts rows of the
 * given kinds since `now - windowMs`, excluding every `skipped_*` outcome
 * (`skipped_no_key` included); `attempted` and `error` DO count. Filters on the
 * address hash only when `email` is given (the global admin cap omits it).
 * THROWS on DB error.
 *
 * RESERVE-THEN-COUNT: the caller must claim its own `attempted` row first and
 * then count, so the count includes the claim and concurrent callers see each
 * other's claims. Count-then-insert would let a burst all read a count under
 * the cap.
 */
export async function countRecentSends(
  db: EmailSendsDb,
  opts: { kinds: readonly EmailSendKind[]; email?: string; windowMs: number; now?: Date }
): Promise<number> {
  const since = new Date((opts.now ?? new Date()).getTime() - opts.windowMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSendsTable)
    .where(
      and(
        inArray(emailSendsTable.kind, [...opts.kinds]),
        opts.email === undefined ? undefined : eq(emailSendsTable.emailHash, hashAddress(opts.email)),
        gte(emailSendsTable.createdAt, since),
        notInArray(emailSendsTable.outcome, ["skipped_no_key", ...EMAIL_SEND_SKIP_OUTCOMES])
      )
    );
  return row?.n ?? 0;
}
