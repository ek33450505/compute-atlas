/**
 * Check for incomplete state digest runs (where completedAt IS NULL).
 *
 * The state digest feature (`STATE_DIGEST_ENABLED`, LIVE since 2026-09-14) records a
 * row in `state_digest_runs` and CLAIMS it BEFORE sending (sets `started_at`).
 * If the run crashes mid-send, `completedAt` remains NULL. This script detects
 * that case and reports it.
 *
 * Design:
 *   - If the table does not exist (migration 0013 not applied): no-op (exit 0,
 *     nothing to check). This is expected in forks or pre-migration DBs.
 *   - If the table exists and is empty: no-op (exit 0, feature has never run).
 *   - If the table exists and all rows have completedAt set: healthy (exit 0).
 *   - If the table exists and any row has completedAt NULL: CRASHED (exit 1).
 *       Multiple NULL rows are technically possible; report all of them.
 *   - If DATABASE_URL is unset or Neon is unreachable: fail closed (exit 1)
 *       with a clear error — a watchdog that skips when it cannot check is
 *       the exact instrument this exists to replace.
 *
 * Two further checks run after the crash check, and ALL failures are reported in
 * one run (exit 1 if any failed):
 *   - Final send errors: for the newest `state_digest_runs` row (by startedAt), a
 *     recipient counts as failed only if its FINAL `email_sends` row for that run
 *     (latest createdAt per subscriptionId, or per emailHash when subscriptionId is
 *     null) is `error` or still `attempted`; a rate-limited send that the retry
 *     then delivered is not a failure. A run started within DIGEST_ERROR_WINDOW_MS
 *     fails the check (counts by errorCode, never recipient identifiers); an older
 *     run only emits a `::warning::`. A missing `email_sends` table is a no-op.
 *   - Recipient-count alarm: confirmed subscriptions of the types the digest reads
 *     (state, plus county/metro unless WATCH_AREAS_ENABLED=false) above
 *     DIGEST_RECIPIENT_ALARM fail, because the route has a time budget.
 *
 * This script NEVER edits, deletes, or "fixes" anything; reporting is the only
 * action. An incomplete run (crashed, or stopped at the route's send deadline) is
 * recovered by re-calling `GET /api/cron/state-digest?since=<YYYY-MM-DD>&until=<YYYY-MM-DD>`
 * for the same window on the admin bearer, once the run is at least 10 minutes old
 * (`STALE_DIGEST_RUN_MS` in the route). That RESUMES the run: everyone already sent or
 * ambiguous is skipped, and the response's `ambiguous` field is a COUNT only: find
 * those recipients in `email_sends` for that run_id (final row not `sent`: `attempted`,
 * or `error` with a code other than `rate_limit_exceeded`) and check them in Resend. Do NOT delete the `state_digest_runs` row: that re-mails everyone.
 *
 * Run: npx tsx --env-file=.env.local scripts/discovery/check-digest-status.ts
 *      (local, reads .env.local; there is no package.json shortcut for this
 *      script yet, unlike check:heartbeat)
 * Or:  npx tsx scripts/discovery/check-digest-status.ts (CI, reads DATABASE_URL
 *       from env)
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { formatErrorSummary, redactedErrorCode } from "../../lib/db-error";
import { getDb, hasDatabaseUrl } from "../../lib/db/client";
import {
  emailSendsTable,
  stateDigestRunsTable,
  subscriptionsTable,
  type StateDigestRunRow,
} from "../../lib/db/schema";
import { WATCH_TARGET, watchAreasEnabled } from "../../lib/watch-target-types";
import { isEntrypoint } from "../is-entrypoint";

export type IncompleteRun = Pick<StateDigestRunRow, "id" | "startedAt" | "since" | "until">;

// --- errors ---------------------------------------------------------------

/**
 * Thrown when one or more digest runs are incomplete (completedAt IS NULL).
 */
export class DigestCrashError extends Error {
  readonly rows: IncompleteRun[];

  constructor(rows: IncompleteRun[]) {
    const count = rows.length;
    const details = rows
      .map(
        (r) =>
          `run [${r.id}] started ${new Date(r.startedAt).toISOString()} ` +
          `for window ${new Date(r.since).toISOString()} .. ${new Date(r.until).toISOString()}`
      )
      .join("; ");
    super(
      `${count} incomplete state digest run(s) found (completedAt IS NULL). ` +
        `The feature claims a run BEFORE sending, so a NULL completed_at means the ` +
        `run crashed or stopped at its send deadline. If it is under 10 minutes old it may ` +
        `still be running: wait. Otherwise re-call GET /api/cron/state-digest?since=<YYYY-MM-DD>&until=<YYYY-MM-DD> ` +
        `for the same window on the admin bearer; that resumes the run and skips everyone ` +
        `already sent or ambiguous, and reports an "ambiguous" count; find those recipients in email_sends ` +
        `for the run_id (final row attempted, or error with a code other than rate_limit_exceeded) and check them in Resend. ` +
        `Do NOT delete the state_digest_runs row: that re-mails everyone. ` +
        `Incomplete runs: ${details}`
    );
    this.name = "DigestCrashError";
    this.rows = rows;
  }
}

/**
 * Thrown when the database connection fails or the table schema cannot be queried.
 * This is distinct from a table that doesn't exist yet (which is expected and
 * not an error — the feature simply hasn't been deployed to this DB).
 */
export class DigestCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestCheckError";
  }
}

// --- pure checks -------------------------------------------------------------

/**
 * A run older than this only warns about send errors instead of failing. The digest
 * is monthly, so without a cutoff one bad run would keep the weekday watchdog red
 * for ~30 days; a week is long enough for the next watchdog runs to surface it and
 * for a human to react, after which it is history, not an incident.
 */
export const DIGEST_ERROR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Confirmed digest subscriptions above which the check fails. The route stops
 * starting groups at maxDuration (300 s) - DIGEST_GROUP_WORST_CASE_MS (~57 s) = ~243 s.
 * Per paced send: the 600 ms pace (lib/send-pacer.ts) plus ~0.2 s for the gate's DB round
 * trips and the Resend call = ~0.8 s, so capacity is ~300 recipients and 150 is ~50% of it,
 * leaving room for slower sends. The 0.2 s is MEASURED but from one 14-send sample
 * (production run 0190a7e5, 2026-11-01, unpaced: 14 email_sends rows in 1.51 s, ~0.11 s each,
 * doubled to be conservative). Re-measure from the 2026-12-01 run's email_sends timestamps;
 * re-derive if maxDuration, DIGEST_GROUP_WORST_CASE_MS (lib/notify.ts) or the pace changes.
 */
export const DIGEST_RECIPIENT_ALARM = 150;

export interface SendRow {
  id: string;
  subscriptionId: string | null;
  emailHash: string;
  outcome: string;
  errorCode: string | null;
  createdAt: Date;
}

/**
 * Final outcomes that mean "the system, not the recipient, stopped the mail":
 *   - `error`: the send failed.
 *   - `attempted`: no final outcome was recorded (completeSend swallows its UPDATE
 *     error, so the mail may or may not have left); counted so it is looked at.
 *   - `skipped_no_key`: the Resend key was absent, nothing was mailed.
 *   - `skipped_check_failed`: the suppression lookup errored, so the recipient was
 *     not mailed although nothing suppressed them.
 * Deliberate skips are NOT failures: `skipped_suppressed`, `skipped_unconfirmed`,
 * `skipped_capped`, `skipped_duplicate`.
 */
const FAILED_FINAL_OUTCOMES = new Set(["error", "attempted", "skipped_no_key", "skipped_check_failed"]);

/**
 * Latest row per recipient (subscriptionId, else emailHash) that did not end well.
 * A tie on createdAt resolves to the greater id, so the result is deterministic.
 */
export function finalFailures(rows: SendRow[]): SendRow[] {
  const latest = new Map<string, SendRow>();
  for (const r of rows) {
    const key = r.subscriptionId ? `s:${r.subscriptionId}` : `h:${r.emailHash}`;
    const prev = latest.get(key);
    const newer =
      !prev ||
      r.createdAt.getTime() > prev.createdAt.getTime() ||
      (r.createdAt.getTime() === prev.createdAt.getTime() && r.id > prev.id);
    if (newer) latest.set(key, r);
  }
  return [...latest.values()].filter((r) => FAILED_FINAL_OUTCOMES.has(r.outcome));
}

export interface SendErrorVerdict {
  level: "ok" | "warning" | "fail";
  message: string;
}

/** Fixed-text verdict for the newest run's finally-failed recipients; never names a recipient. */
export function classifySendErrors(
  run: { id: string; startedAt: Date },
  rows: SendRow[],
  now: Date
): SendErrorVerdict {
  const failed = finalFailures(rows);
  if (failed.length === 0) return { level: "ok", message: "" };
  const byCode = new Map<string, number>();
  for (const r of failed) {
    const code =
      r.outcome === "attempted"
        ? "attempted_no_final_outcome"
        : r.outcome === "error"
          ? r.errorCode === "send_timeout"
            ? "send_timeout_may_have_left"
            : (r.errorCode ?? "unknown")
          : r.outcome;
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  const counts = [...byCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, n]) => `${code}=${n}`)
    .join(", ");
  // Both labels mean the mail may have gone out anyway: no outcome was recorded, or the
  // timed-out Resend call was abandoned but may still deliver.
  const noFinal =
    byCode.has("attempted_no_final_outcome") || byCode.has("send_timeout_may_have_left")
      ? " attempted_no_final_outcome (no outcome recorded) and send_timeout_may_have_left (abandoned call) mean the send may still have left."
      : "";
  const message =
    `${failed.length} digest recipient(s) in run [${run.id}] were not mailed (by code: ${counts}).` +
    `${noFinal} Check email_sends for this run in Neon.`;
  const age = now.getTime() - run.startedAt.getTime();
  return { level: age <= DIGEST_ERROR_WINDOW_MS ? "fail" : "warning", message };
}

/** Returns a failure message when the recipient count exceeds the alarm, else null. */
export function recipientAlarm(count: number): string | null {
  if (count <= DIGEST_RECIPIENT_ALARM) return null;
  return (
    `${count} confirmed digest subscriptions exceed the alarm of ${DIGEST_RECIPIENT_ALARM}. ` +
    `The digest route stops at its time budget, so recipients past it go unmailed. ` +
    `Raise maxDuration in app/api/cron/state-digest/route.ts within the plan limit, or batch the digest.`
  );
}

// --- query -----------------------------------------------------------------

/**
 * Attempts to fetch incomplete digest runs from the database.
 *
 * Selects named columns only. The CI role (scripts/ops/create-ci-monitor-role.ts) is
 * column-granted on email_sends and subscriptions, so every query in this script must name
 * its columns; a select() without a list would be refused for the ungranted ones (and
 * subscriptions.email must never be readable by CI).
 *
 * Returns:
 *   - null if the table does not exist (expected in forks or pre-migration DBs)
 *   - an array (possibly empty) if the table exists
 *
 * Throws DigestCheckError if the database connection fails or a query error
 * occurs for some other reason.
 */
export async function fetchIncompleteRuns(): Promise<IncompleteRun[] | null> {
  const db = getDb();

  // Attempt to query. If the table doesn't exist (Postgres error code 42P01,
  // "undefined_table"), catch it and return null. Any other error is
  // unexpected and propagates. Check the driver's structured `.code` field
  // FIRST (the reliable signal — `NeonDbError` always carries the real
  // Postgres SQLSTATE there) and fall back to a message substring match only
  // as a belt-and-suspenders check, since relying on message text alone is
  // fragile to driver/message-format changes.
  try {
    const rows = await db
      .select({
        id: stateDigestRunsTable.id,
        startedAt: stateDigestRunsTable.startedAt,
        since: stateDigestRunsTable.since,
        until: stateDigestRunsTable.until,
      })
      .from(stateDigestRunsTable)
      .where(isNull(stateDigestRunsTable.completedAt));
    return rows;
  } catch (err) {
    if (isMissingTable(err, "state_digest_runs")) {
      return null;
    }
    // Any other error is unexpected — log it and fail.
    throw new DigestCheckError(
      `Failed to query state_digest_runs: ${redactedErrorCode(err)}`
    );
  }
}

/**
 * True only for "undefined_table" (42P01) on THE expected relation. Drizzle wraps
 * driver errors, so the SQLSTATE and message are read from the error and its cause.
 */
export function isMissingTable(err: unknown, table: string): boolean {
  const layers = [err, (err as { cause?: unknown } | null)?.cause];
  return layers.some((e) => {
    const code = (e as { code?: string } | null)?.code;
    const message = e instanceof Error ? e.message : "";
    return code === "42P01" && message.includes(`relation "${table}" does not exist`);
  });
}

/** Newest digest run plus its send rows; null when either table is missing or no run exists. */
export async function fetchNewestRunSends(): Promise<{
  run: { id: string; startedAt: Date };
  rows: SendRow[];
} | null> {
  const db = getDb();
  try {
    const [run] = await db
      .select({ id: stateDigestRunsTable.id, startedAt: stateDigestRunsTable.startedAt })
      .from(stateDigestRunsTable)
      .orderBy(desc(stateDigestRunsTable.startedAt))
      .limit(1);
    if (!run) return null;
    const rows = await db
      .select({
        id: emailSendsTable.id,
        subscriptionId: emailSendsTable.subscriptionId,
        emailHash: emailSendsTable.emailHash,
        outcome: emailSendsTable.outcome,
        errorCode: emailSendsTable.errorCode,
        createdAt: emailSendsTable.createdAt,
      })
      .from(emailSendsTable)
      .where(and(eq(emailSendsTable.runId, run.id), inArray(emailSendsTable.kind, ["state_digest", "area_digest"])));
    return { run, rows };
  } catch (err) {
    if (isMissingTable(err, "email_sends") || isMissingTable(err, "state_digest_runs")) return null;
    throw new DigestCheckError(`Failed to query digest sends: ${redactedErrorCode(err)}`);
  }
}

/** Confirmed subscriptions of the target types the digest reads. */
export async function countDigestSubscriptions(): Promise<number> {
  const db = getDb();
  const targetTypes = watchAreasEnabled()
    ? [WATCH_TARGET.state, WATCH_TARGET.county, WATCH_TARGET.metro]
    : [WATCH_TARGET.state];
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.status, "confirmed"), inArray(subscriptionsTable.targetType, targetTypes)));
    return row?.n ?? 0;
  } catch (err) {
    throw new DigestCheckError(`Failed to count digest subscriptions: ${redactedErrorCode(err)}`);
  }
}

export interface CheckDeps {
  fetchIncompleteRuns: () => Promise<IncompleteRun[] | null>;
  fetchNewestRunSends: () => Promise<{ run: { id: string; startedAt: Date }; rows: SendRow[] } | null>;
  countDigestSubscriptions: () => Promise<number>;
  now: () => Date;
}

export interface CheckReport {
  failures: string[];
  warnings: string[];
  notes: string[];
}

/** A thrown check becomes a failure line; DB errors are already redacted by their producers. */
function describeError(err: unknown): string {
  // lint-no-raw-error-logs: allow -- own error class; its producers build the message from formatErrorSummary/redactedErrorCode, which redact DB errors
  if (err instanceof DigestCheckError) return err.message;
  return `digest status check errored: ${formatErrorSummary(err)}`;
}

/**
 * Runs the three checks independently: an error in one is recorded as a failure
 * and the others still run, so one broken query cannot hide a second problem.
 */
export async function runChecks(deps: CheckDeps): Promise<CheckReport> {
  const report: CheckReport = { failures: [], warnings: [], notes: [] };

  try {
    const incompleteRuns = await deps.fetchIncompleteRuns();
    if (incompleteRuns === null) {
      report.notes.push("✓ state_digest_runs table does not exist (feature not yet deployed to this DB).");
    } else if (incompleteRuns.length === 0) {
      report.notes.push("✓ state_digest_runs table is empty or all runs completed (no crashed runs detected).");
    } else {
      report.failures.push(new DigestCrashError(incompleteRuns).message);
    }
  } catch (err) {
    report.failures.push(describeError(err));
  }

  // The send check does its own missing-table detection, so it runs regardless of the crash check.
  try {
    const newest = await deps.fetchNewestRunSends();
    if (newest) {
      const verdict = classifySendErrors(newest.run, newest.rows, deps.now());
      if (verdict.level === "fail") report.failures.push(verdict.message);
      else if (verdict.level === "warning") report.warnings.push(verdict.message);
      else report.notes.push("✓ newest digest run has no finally-failed sends.");
    }
  } catch (err) {
    report.failures.push(describeError(err));
  }

  try {
    const alarm = recipientAlarm(await deps.countDigestSubscriptions());
    if (alarm) report.failures.push(alarm);
    else report.notes.push("✓ confirmed digest subscriptions are within the recipient alarm.");
  } catch (err) {
    report.failures.push(describeError(err));
  }

  return report;
}

// --- CLI -------------------------------------------------------------------

async function main(): Promise<void> {
  // Fail CLOSED — an unconfigured database is a failure to verify, not a skip.
  // Matches the posture of check-heartbeat.ts and check-schema-drift.ts.
  if (!hasDatabaseUrl()) {
    console.error(
      "::error::DATABASE_URL is not set. Configure it in .env.local (see .env.example) for a local " +
        "run, or as a secret for the scheduled CI run. This check fails closed rather than skipping."
    );
    process.exit(1);
    return;
  }

  const { failures, warnings, notes } = await runChecks({
    fetchIncompleteRuns,
    fetchNewestRunSends,
    countDigestSubscriptions,
    now: () => new Date(),
  });
  for (const n of notes) console.log(n);
  for (const w of warnings) console.warn(`::warning::${w}`);
  for (const f of failures) {
    // lint-no-raw-error-logs: allow -- messages are fixed text, run ids and counts, or already-redacted summaries
    console.error(`::error::${f}`);
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

// Only run the CLI when this file is executed directly, not when imported
// by the test suite — matches the isMain guard used across this directory's
// other check-*/publish-*.ts scripts.
const isMainModule = isEntrypoint(import.meta.url);
if (isMainModule) {
  main();
}
