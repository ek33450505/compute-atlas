/**
 * Freshness watchdog for the things nothing else watches: the Vercel crons, the weekly
 * dataset edition, PayPal webhooks and outbound mail. Read-only: it only SELECTs and
 * reports. Four independent checks; every failure is reported and any one exits 1.
 *
 *   1. Digest cron: newest `state_digest_runs.started_at` within DIGEST_MAX_AGE_MS. The
 *      cron is monthly (`0 9 1 * *`, so gaps are at most 31 days; 32 leaves a day of slack).
 *      An EMPTY table is a note, not a failure, because the digest legitimately may never
 *      have run. That could in principle hide a cron that never fired, but production has
 *      rows (runs on 2026-10-01 and 2026-11-01), so on production a dead cron surfaces as
 *      the age check instead. Revisit if the table is ever emptied.
 *   2. Dataset edition (only when DATASET_SHARING_ENABLED is exactly "true", like
 *      lib/dataset-flag.ts): newest `dataset_editions.built_at` within EDITION_MAX_AGE_MS
 *      (the cron is weekly, Fridays 14:00 UTC), the newest row not `failed`, and not
 *      `building` for more than EDITION_BUILD_STALE_MS. No editions at all (or no table)
 *      FAILS here: the flag says the lane is live and a first edition already exists.
 *   3. PayPal: any `paypal_webhook_events` row unprocessed for over 24 h fails. Count only:
 *      never ids, event types or payloads.
 *   4. Mail: `email_sends` rows of ANY kind from the last 7 days whose FINAL row per
 *      (recipient, kind, run-or-day) is a system failure. A rate-limited send that the retry
 *      delivered is not one: the final-row logic is check-digest-status's `finalFailures`,
 *      applied to each (kind, run-or-day) partition. Reported as counts by kind and code.
 *
 * Fails CLOSED on a missing DATABASE_URL or any query error other than a missing table
 * (which is a note: forks and pre-migration databases). It needs SELECT on
 * state_digest_runs, dataset_editions, paypal_webhook_events and email_sends, which is
 * what scripts/ops/create-ci-monitor-role.ts grants the CI role.
 *
 * Run: npx tsx --env-file=.env.local scripts/ops/check-cron-freshness.ts   (npm run check:cron)
 */
import { and, desc, gte, isNull, lt, sql } from "drizzle-orm";

import { formatErrorSummary, redactedErrorCode } from "../../lib/db-error";
import { getDb, hasDatabaseUrl } from "../../lib/db/client";
import {
  datasetEditionsTable,
  emailSendsTable,
  paypalWebhookEventsTable,
  stateDigestRunsTable,
} from "../../lib/db/schema";
import { finalFailures, isMissingTable, type SendRow } from "../discovery/check-digest-status";
import { isEntrypoint } from "../is-entrypoint";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DIGEST_MAX_AGE_MS = 32 * DAY_MS;
export const EDITION_MAX_AGE_MS = 8 * DAY_MS;
export const EDITION_BUILD_STALE_MS = 2 * HOUR_MS;
export const PAYPAL_UNPROCESSED_MS = 24 * HOUR_MS;
export const MAIL_WINDOW_MS = 7 * DAY_MS;

// --- types ---------------------------------------------------------------

/** Thrown by the queries; the message is already redacted (SQLSTATE only). */
export class CronCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronCheckError";
  }
}

export interface EditionHead {
  builtAt: Date;
  status: string;
}

export interface MailRow extends SendRow {
  kind: string;
  runId: string | null;
}

/** Each fetcher returns null when the table is missing or has no matching data. */
export interface CronDeps {
  fetchNewestDigestStart: () => Promise<Date | null>;
  fetchNewestEdition: () => Promise<EditionHead | null>;
  countStalePaypalEvents: (cutoff: Date) => Promise<number | null>;
  fetchRecentSends: (since: Date) => Promise<MailRow[] | null>;
  datasetSharingEnabled: boolean;
  now: () => Date;
}

export interface CronReport {
  failures: string[];
  notes: string[];
}

// --- pure checks ----------------------------------------------------------

function ageDays(from: Date, now: Date): string {
  return ((now.getTime() - from.getTime()) / DAY_MS).toFixed(1);
}

export function checkDigestFreshness(newest: Date | null, now: Date): { failure?: string; note?: string } {
  if (newest === null) {
    return { note: "✓ digest cron: no state_digest_runs rows (or table absent); nothing to age-check." };
  }
  const age = now.getTime() - newest.getTime();
  if (age > DIGEST_MAX_AGE_MS) {
    return {
      failure:
        `State digest cron looks dead: newest state_digest_runs.started_at is ${newest.toISOString()} ` +
        `(${ageDays(newest, now)} days ago; limit ${DIGEST_MAX_AGE_MS / DAY_MS}). ` +
        `Check the Vercel cron log for /api/cron/state-digest.`,
    };
  }
  return { note: `✓ digest cron: newest run ${ageDays(newest, now)} days ago.` };
}

export function checkEdition(newest: EditionHead | null, now: Date): { failures: string[]; note?: string } {
  if (newest === null) {
    // The flag says the lane is live, so "no table" or "no rows" is a broken lane, not a quiet one.
    return {
      failures: [
        "DATASET_SHARING_ENABLED is true but there is no dataset edition (dataset_editions is empty or missing). " +
          "Check the Vercel cron log for /api/cron/dataset-edition.",
      ],
    };
  }
  const failures: string[] = [];
  const age = now.getTime() - newest.builtAt.getTime();
  if (age > EDITION_MAX_AGE_MS) {
    failures.push(
      `Dataset edition cron looks dead: newest dataset_editions.built_at is ${newest.builtAt.toISOString()} ` +
        `(${ageDays(newest.builtAt, now)} days ago; limit ${EDITION_MAX_AGE_MS / DAY_MS}). ` +
        `Check the Vercel cron log for /api/cron/dataset-edition.`
    );
  }
  if (newest.status === "failed") {
    failures.push(`Newest dataset edition (built ${newest.builtAt.toISOString()}) has status failed.`);
  }
  if (newest.status === "building" && age > EDITION_BUILD_STALE_MS) {
    failures.push(
      `Newest dataset edition (built ${newest.builtAt.toISOString()}) has been building for over ` +
        `${EDITION_BUILD_STALE_MS / HOUR_MS} hours; the build likely crashed.`
    );
  }
  if (failures.length > 0) return { failures };
  return { failures, note: `✓ dataset edition: newest is ${newest.status}, built ${ageDays(newest.builtAt, now)} days ago.` };
}

/** Count only: never ids, event types or payloads. */
export function checkPaypal(stale: number | null): { failure?: string; note?: string } {
  if (stale === null) return { note: "✓ paypal: paypal_webhook_events table absent; nothing to check." };
  if (stale > 0) {
    return {
      failure:
        `${stale} PayPal webhook event(s) received over ${PAYPAL_UNPROCESSED_MS / HOUR_MS} hours ago ` +
        `are still unprocessed (processed_at IS NULL). Check paypal_webhook_events in Neon.`,
    };
  }
  return { note: "✓ paypal: no webhook events unprocessed for over 24 hours." };
}

function sendCode(r: SendRow): string {
  if (r.outcome === "attempted") return "attempted_no_final_outcome";
  if (r.outcome === "error") return r.errorCode ?? "unknown";
  return r.outcome;
}

/**
 * Final-row failures per (kind, run-or-UTC-day) partition, so one recipient's retry
 * chain within a run collapses to its last row (finalFailures keys by recipient).
 */
export function mailFailures(rows: MailRow[]): { kind: string; code: string; n: number }[] {
  const parts = new Map<string, MailRow[]>();
  for (const r of rows) {
    const key = `${r.kind}|${r.runId ? `run:${r.runId}` : `day:${r.createdAt.toISOString().slice(0, 10)}`}`;
    const list = parts.get(key);
    if (list) list.push(r);
    else parts.set(key, [r]);
  }
  const counts = new Map<string, { kind: string; code: string; n: number }>();
  for (const list of parts.values()) {
    for (const f of finalFailures(list)) {
      const kind = list[0].kind;
      const code = sendCode(f);
      const k = `${kind}|${code}`;
      const prev = counts.get(k);
      if (prev) prev.n += 1;
      else counts.set(k, { kind, code, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => `${a.kind}|${a.code}`.localeCompare(`${b.kind}|${b.code}`));
}

export function checkMail(rows: MailRow[] | null): { failure?: string; note?: string } {
  if (rows === null) return { note: "✓ mail: email_sends table absent; nothing to check." };
  const failed = mailFailures(rows);
  if (failed.length === 0) return { note: `✓ mail: no finally-failed sends in the last ${MAIL_WINDOW_MS / DAY_MS} days.` };
  const total = failed.reduce((s, f) => s + f.n, 0);
  const detail = failed.map((f) => `${f.kind}/${f.code}=${f.n}`).join(", ");
  return {
    failure:
      `${total} email send(s) in the last ${MAIL_WINDOW_MS / DAY_MS} days were not delivered by the system ` +
      `(by kind/code: ${detail}). attempted_no_final_outcome means the mail may still have left. Check email_sends in Neon.`,
  };
}

/** A thrown check becomes a failure line; DB errors are already redacted by their producers. */
function describeError(err: unknown): string {
  // lint-no-raw-error-logs: allow -- own error class; its producers build the message from formatErrorSummary/redactedErrorCode
  if (err instanceof CronCheckError) return err.message;
  return `cron freshness check errored: ${formatErrorSummary(err)}`;
}

/** Runs every check independently: an error in one is a failure and the others still run. */
export async function runChecks(deps: CronDeps): Promise<CronReport> {
  const report: CronReport = { failures: [], notes: [] };
  const now = deps.now();

  try {
    const r = checkDigestFreshness(await deps.fetchNewestDigestStart(), now);
    if (r.failure) report.failures.push(r.failure);
    if (r.note) report.notes.push(r.note);
  } catch (err) {
    report.failures.push(describeError(err));
  }

  if (deps.datasetSharingEnabled) {
    try {
      const r = checkEdition(await deps.fetchNewestEdition(), now);
      report.failures.push(...r.failures);
      if (r.note) report.notes.push(r.note);
    } catch (err) {
      report.failures.push(describeError(err));
    }
  } else {
    report.notes.push("✓ dataset edition: skipped (DATASET_SHARING_ENABLED is not \"true\").");
  }

  try {
    const r = checkPaypal(await deps.countStalePaypalEvents(new Date(now.getTime() - PAYPAL_UNPROCESSED_MS)));
    if (r.failure) report.failures.push(r.failure);
    if (r.note) report.notes.push(r.note);
  } catch (err) {
    report.failures.push(describeError(err));
  }

  try {
    const r = checkMail(await deps.fetchRecentSends(new Date(now.getTime() - MAIL_WINDOW_MS)));
    if (r.failure) report.failures.push(r.failure);
    if (r.note) report.notes.push(r.note);
  } catch (err) {
    report.failures.push(describeError(err));
  }

  return report;
}

// --- queries --------------------------------------------------------------

export async function fetchNewestDigestStart(): Promise<Date | null> {
  try {
    const [row] = await getDb()
      .select({ startedAt: stateDigestRunsTable.startedAt })
      .from(stateDigestRunsTable)
      .orderBy(desc(stateDigestRunsTable.startedAt))
      .limit(1);
    return row?.startedAt ?? null;
  } catch (err) {
    if (isMissingTable(err, "state_digest_runs")) return null;
    throw new CronCheckError(`Failed to query state_digest_runs: ${redactedErrorCode(err)}`);
  }
}

export async function fetchNewestEdition(): Promise<EditionHead | null> {
  try {
    const [row] = await getDb()
      .select({ builtAt: datasetEditionsTable.builtAt, status: datasetEditionsTable.status })
      .from(datasetEditionsTable)
      .orderBy(desc(datasetEditionsTable.builtAt))
      .limit(1);
    return row ?? null;
  } catch (err) {
    if (isMissingTable(err, "dataset_editions")) return null;
    throw new CronCheckError(`Failed to query dataset_editions: ${redactedErrorCode(err)}`);
  }
}

export async function countStalePaypalEvents(cutoff: Date): Promise<number | null> {
  try {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(paypalWebhookEventsTable)
      .where(and(isNull(paypalWebhookEventsTable.processedAt), lt(paypalWebhookEventsTable.receivedAt, cutoff)));
    return row?.n ?? 0;
  } catch (err) {
    if (isMissingTable(err, "paypal_webhook_events")) return null;
    throw new CronCheckError(`Failed to query paypal_webhook_events: ${redactedErrorCode(err)}`);
  }
}

export async function fetchRecentSends(since: Date): Promise<MailRow[] | null> {
  try {
    return await getDb()
      .select({
        id: emailSendsTable.id,
        kind: emailSendsTable.kind,
        runId: emailSendsTable.runId,
        subscriptionId: emailSendsTable.subscriptionId,
        emailHash: emailSendsTable.emailHash,
        outcome: emailSendsTable.outcome,
        errorCode: emailSendsTable.errorCode,
        createdAt: emailSendsTable.createdAt,
      })
      .from(emailSendsTable)
      .where(gte(emailSendsTable.createdAt, since));
  } catch (err) {
    if (isMissingTable(err, "email_sends")) return null;
    throw new CronCheckError(`Failed to query email_sends: ${redactedErrorCode(err)}`);
  }
}

// --- CLI ------------------------------------------------------------------

async function main(): Promise<void> {
  // Fail CLOSED: an unconfigured database is a failure to verify, not a skip.
  if (!hasDatabaseUrl()) {
    console.error(
      "::error::DATABASE_URL is not set. Configure it in .env.local (see .env.example) for a local " +
        "run, or as a secret for the scheduled CI run. This check fails closed rather than skipping."
    );
    process.exit(1);
    return;
  }

  const { failures, notes } = await runChecks({
    fetchNewestDigestStart,
    fetchNewestEdition,
    countStalePaypalEvents,
    fetchRecentSends,
    datasetSharingEnabled: process.env.DATASET_SHARING_ENABLED === "true",
    now: () => new Date(),
  });
  for (const n of notes) console.log(n);
  for (const f of failures) {
    // lint-no-raw-error-logs: allow -- messages are fixed text, counts, timestamps or already-redacted summaries
    console.error(`::error::${f}`);
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

if (isEntrypoint(import.meta.url)) {
  main();
}
