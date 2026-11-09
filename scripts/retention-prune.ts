/**
 * Fail-closed PII-retention pruner. Nightly, maintainer-machine-only script
 * that deletes (or partially redacts) rows that have aged out of the
 * documented retention windows below. DRY RUN IS THE DEFAULT: with no flags
 * this only SELECTs and reports per-table candidate counts — nothing is
 * written or deleted. Pass --apply to actually mutate.
 *
 * Safety contract (back-up-or-abort, per table):
 *   1. Dry run by default; --apply is required for any write.
 *   2. Before a table's DELETE/UPDATE, its full candidate rows are appended
 *      as JSON lines to a single per-run backup file under
 *      discovery-logs/retention-backups/, then the file is verified
 *      non-empty. If the backup write fails, that table's mutation is
 *      SKIPPED (never attempted), the failure is recorded on that table's
 *      outcome, and the run continues to the next table — the overall
 *      process still exits non-zero.
 *   3. The mutation re-applies the SAME WHERE predicate used for the
 *      candidate select (never "delete the ids selected earlier"), so a row
 *      that changed between select and mutate isn't wrongly hit.
 *   4. The backup files themselves are deleted once their FILENAME timestamp
 *      is older than RETENTION_BACKUP_RETENTION_DAYS (immediate entries of the
 *      backup dir only, regular files matching this script's own naming; a
 *      symlink or directory is never touched).
 *
 * Run: npm run retention:prune               (dry run — read-only, safe anytime)
 *      npm run retention:prune -- --apply    (writes — see safety contract above)
 *
 * Uses relative imports, matching scripts/export.ts.
 */
import { appendFileSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { and, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import {
  apiAccessGrantsTable,
  apiDailyUsageTable,
  contactMessagesTable,
  datasetAccessGrantsTable,
  datasetDownloadsTable,
  intakeAttemptsTable,
  leadsTable,
  submissionsTable,
  submissionNotifyRequestsTable,
  submissionNotifySendsTable,
  emailSendsTable,
  subscribeAttemptsTable,
  subscriptionsTable,
} from "../lib/db/schema";
import { isEntrypoint } from "./is-entrypoint";
import { formatFatalError } from "../lib/db-error";

// --- retention windows -------------------------------------------------
// Single source of truth (scripts/discovery/run.sh's nightly lane points
// readers here rather than duplicating the numbers).
export const CONTACT_MESSAGES_RETENTION_DAYS = 180; // contact_messages: delete rows older than this many days (by createdAt)
export const LEADS_RETENTION_DAYS = 365; // leads: delete promoted/dismissed rows whose reviewedAt (falling back to createdAt) is older than this many days
export const SUBMISSIONS_IP_HASH_RETENTION_DAYS = 90; // submissions: strip provenance.submitterIpHash from reviewed (non-pending) rows older than this many days (by reviewedAt) — the submission row itself is never deleted
export const SUBSCRIPTIONS_UNSUBSCRIBED_RETENTION_DAYS = 30; // subscriptions: delete unsubscribed rows older than this many days (by unsubscribedAt)
export const SUBSCRIBE_ATTEMPTS_RETENTION_DAYS = 2; // subscribe_attempts: delete rows older than this many days (by createdAt) — the cap window is 1h, so 2 days is already far beyond useful life
export const INTAKE_ATTEMPTS_RETENTION_DAYS = 2; // intake_attempts: same as subscribe_attempts above (same 1h cap window, same salted-IP-hash-only payload) — deliberately the same number, not an independent knob
export const SUBMISSION_NOTIFY_RETENTION_DAYS = 90; // submission_notify_requests: delete rows whose submission was never reviewed — otherwise a submission that never gets reviewed leaves its address sitting forever
export const SUBMISSION_NOTIFY_SENDS_RETENTION_DAYS = 60; // submission_notify_sends: delete rows older than this many days (by createdAt) — comfortably beyond the 30-day SUBMISSION_NOTIFY_SEND_WINDOW_MS cap window (lib/rate-limit.ts), so pruning can never shorten the cap
export const EMAIL_SENDS_RETENTION_DAYS = 180; // email_sends: delete rows older than this many days (by createdAt) — at least 3x the 30-day CONFIRM_CAP_WINDOW_MS (lib/email-sends.ts, pinned by a test), so pruning can never shorten the confirm cap
export const API_ACCESS_GRANTS_RETENTION_DAYS = 90; // api_access_grants: delete revoked-or-expired rows older than this many days (by revokedAt/expiresAt)
export const API_DAILY_USAGE_RETENTION_DAYS = 35; // api_daily_usage: delete daily per-IP counters older than this many days (by the `day` text column)
// Dataset sharing. These six figures are the public privacy notice (DATASET_PRIVACY_NOTICE in
// lib/dataset-terms.ts), pinned by a test: change the notice and the number together or not at all.
export const DATASET_UNVERIFIED_RETENTION_DAYS = 7; // dataset_access_grants: delete `unverified` rows older than this many days (by createdAt, which every verification-link rotation resets)
export const DATASET_REJECTED_RETENTION_DAYS = 180; // dataset_access_grants: delete `rejected` rows this many days after reviewedAt
export const DATASET_ENDED_RETENTION_DAYS = 365; // dataset_access_grants: delete `revoked` rows this many days after revokedAt and `expired` rows after expiresAt (their downloads cascade)
export const DATASET_REQUEST_IP_HASH_RETENTION_DAYS = 90; // dataset_access_grants: null submitterIpHash this many days after reviewedAt, whatever the status — the row itself stays
export const DATASET_DOWNLOADS_RETENTION_DAYS = 365; // dataset_downloads: delete rows older than this many days (by createdAt)
export const DATASET_DOWNLOAD_IP_HASH_RETENTION_DAYS = 90; // dataset_downloads: null ipHash on rows older than this many days (by createdAt) — the row itself stays
export const RETENTION_BACKUP_RETENTION_DAYS = 30; // discovery-logs/retention-backups/*.jsonl: delete backup files whose FILENAME timestamp is older than this many days — the dataset privacy notice states it (pinned by a test)

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** "YYYY-MM-DD" in UTC — mirrors the private `utcDateString()` helper duplicated in lib/api-daily-limit.ts and scripts/check-schema-drift.ts. */
function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface RetentionTableOutcome {
  table: string;
  action: "delete" | "strip-ip-hash";
  candidates: number;
  applied: number;
  sampleIds: string[];
  error?: string;
}

export interface RetentionRunOptions {
  apply: boolean;
  /** Injectable clock — tests pass a fixed Date so window-boundary assertions aren't flaky. Defaults to the real clock. */
  now?: Date;
  /** Injectable backup root — defaults to discovery-logs/retention-backups relative to CWD. Tests point this at an isolated temp dir. */
  backupDir?: string;
}

export interface RetentionBackupsOutcome {
  candidates: number;
  deleted: number;
  error?: string;
}

export interface RetentionRunSummary {
  dryRun: boolean;
  backupPath: string | null;
  tables: RetentionTableOutcome[];
  backups: RetentionBackupsOutcome;
  ok: boolean;
}

// Non-generic on purpose: buildSteps() below returns table-specific
// steps in a uniform array, and runStep() only ever touches `.id` (the full
// row still flows through to appendBackup() as `unknown[]` for the JSON
// backup). Making this generic over each table's Row type forces TypeScript
// to distribute a union of RetentionStep<A>|RetentionStep<B>|... across a
// single `for...of`, which it cannot do — see the type error this replaced.
interface RetentionStep {
  table: string;
  action: RetentionTableOutcome["action"];
  selectCandidates: () => Promise<{ id: string }[]>;
  mutate: () => Promise<{ id: string }[]>;
}

/**
 * Appends `rows` (tagged with `table`/`action`) as JSON lines to
 * `backupPath`, creating its parent directory if needed, then verifies the
 * file is non-empty. Never throws — returns `{ok:false, error}` on any
 * failure (e.g. the parent path already exists as a plain file), which is
 * exactly the back-up-or-abort signal `runStep` uses to skip a mutation.
 */
function appendBackup(
  backupPath: string,
  table: string,
  action: RetentionTableOutcome["action"],
  rows: unknown[]
): { ok: boolean; error?: string } {
  try {
    mkdirSync(path.dirname(backupPath), { recursive: true });
    const lines = rows.map((row) => JSON.stringify({ table, action, row })).join("\n") + "\n";
    appendFileSync(backupPath, lines, "utf-8");
    const stat = statSync(backupPath);
    if (stat.size === 0) {
      return { ok: false, error: "backup file is empty after write" };
    }
    return { ok: true };
  } catch (err) {
    /* fake-success-ok: this is the back-up-or-abort signal itself — the
     * caller (runStep) treats ok:false as "skip this table's mutation" and
     * the run exits non-zero, so the failure is surfaced, never masked. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runStep(
  step: RetentionStep,
  opts: { apply: boolean; backupPath: string | null }
): Promise<RetentionTableOutcome> {
  const candidates = await step.selectCandidates();
  const outcome: RetentionTableOutcome = {
    table: step.table,
    action: step.action,
    candidates: candidates.length,
    applied: 0,
    sampleIds: candidates.slice(0, 3).map((row) => row.id),
  };

  if (!opts.apply || candidates.length === 0) {
    return outcome;
  }

  // opts.backupPath is only null in dry-run mode, already returned above.
  const backup = appendBackup(opts.backupPath as string, step.table, step.action, candidates);
  if (!backup.ok) {
    outcome.error = `backup failed, mutation skipped: ${backup.error}`;
    return outcome;
  }

  // Re-applies the SAME predicate as selectCandidates (never "delete the ids
  // just selected") so a row that changed in between isn't wrongly hit.
  const applied = await step.mutate();
  outcome.applied = applied.length;
  return outcome;
}

function buildSteps(now: Date): RetentionStep[] {
  const contactMessagesCutoff = daysAgo(now, CONTACT_MESSAGES_RETENTION_DAYS);
  const contactMessagesPredicate = () => lt(contactMessagesTable.createdAt, contactMessagesCutoff);

  const leadsCutoff = daysAgo(now, LEADS_RETENTION_DAYS);
  const leadsPredicate = () =>
    and(
      inArray(leadsTable.status, ["promoted", "dismissed"]),
      sql`coalesce(${leadsTable.reviewedAt}, ${leadsTable.createdAt}) < ${leadsCutoff}`
    );

  const submissionsCutoff = daysAgo(now, SUBMISSIONS_IP_HASH_RETENTION_DAYS);
  const submissionsPredicate = () =>
    and(
      ne(submissionsTable.status, "pending"),
      lt(submissionsTable.reviewedAt, submissionsCutoff),
      sql`${submissionsTable.provenance} ? 'submitterIpHash'`
    );

  const subscriptionsCutoff = daysAgo(now, SUBSCRIPTIONS_UNSUBSCRIBED_RETENTION_DAYS);
  const subscriptionsPredicate = () =>
    and(
      eq(subscriptionsTable.status, "unsubscribed"),
      lt(subscriptionsTable.unsubscribedAt, subscriptionsCutoff)
    );

  const subscribeAttemptsCutoff = daysAgo(now, SUBSCRIBE_ATTEMPTS_RETENTION_DAYS);
  const subscribeAttemptsPredicate = () => lt(subscribeAttemptsTable.createdAt, subscribeAttemptsCutoff);

  // Deliberately NOT scoped by `surface` — every surface shares the same 1h cap
  // window, so one cutoff prunes them all. A per-surface predicate would be
  // four scans for one outcome.
  const intakeAttemptsCutoff = daysAgo(now, INTAKE_ATTEMPTS_RETENTION_DAYS);
  const intakeAttemptsPredicate = () => lt(intakeAttemptsTable.createdAt, intakeAttemptsCutoff);

  const submissionNotifyCutoff = daysAgo(now, SUBMISSION_NOTIFY_RETENTION_DAYS);
  const submissionNotifyPredicate = () => lt(submissionNotifyRequestsTable.createdAt, submissionNotifyCutoff);

  const submissionNotifySendsCutoff = daysAgo(now, SUBMISSION_NOTIFY_SENDS_RETENTION_DAYS);
  const submissionNotifySendsPredicate = () =>
    lt(submissionNotifySendsTable.createdAt, submissionNotifySendsCutoff);

  const emailSendsCutoff = daysAgo(now, EMAIL_SENDS_RETENTION_DAYS);
  const emailSendsPredicate = () => lt(emailSendsTable.createdAt, emailSendsCutoff);

  const apiAccessGrantsCutoff = daysAgo(now, API_ACCESS_GRANTS_RETENTION_DAYS);
  const apiAccessGrantsPredicate = () =>
    or(
      and(eq(apiAccessGrantsTable.status, "revoked"), lt(apiAccessGrantsTable.revokedAt, apiAccessGrantsCutoff)),
      and(isNotNull(apiAccessGrantsTable.expiresAt), lt(apiAccessGrantsTable.expiresAt, apiAccessGrantsCutoff))
    );

  const apiDailyUsageCutoffDay = utcDateString(daysAgo(now, API_DAILY_USAGE_RETENTION_DAYS));
  const apiDailyUsagePredicate = () => lt(apiDailyUsageTable.day, apiDailyUsageCutoffDay);

  // Dataset sharing. `active` and `pending_review` grants are never selected for deletion: every
  // delete rule below names its own end status AND the timestamp that status sets, so a NULL
  // timestamp compares as NULL (not true) and the row survives.
  const datasetUnverifiedCutoff = daysAgo(now, DATASET_UNVERIFIED_RETENTION_DAYS);
  const datasetRejectedCutoff = daysAgo(now, DATASET_REJECTED_RETENTION_DAYS);
  const datasetEndedCutoff = daysAgo(now, DATASET_ENDED_RETENTION_DAYS);
  const datasetGrantsDeletePredicate = () =>
    or(
      // `unverified` is aged on createdAt even though a verification-link rotation resets it. That does not
      // stretch the notice's "deleted after 7 days" (lib/dataset-terms.ts): the rotation UPDATE replaces EVERY
      // request field (`requestFields` in lib/dataset-grants.ts) with the new submission's values, so no stored
      // data from an earlier request outlives that request's own 7 days; the row id is not request data.
      // Pinned by "a rotation replaces every request field…" in scripts/retention-prune.integration.test.ts.
      and(
        eq(datasetAccessGrantsTable.status, "unverified"),
        lt(datasetAccessGrantsTable.createdAt, datasetUnverifiedCutoff)
      ),
      and(
        eq(datasetAccessGrantsTable.status, "rejected"),
        lt(datasetAccessGrantsTable.reviewedAt, datasetRejectedCutoff)
      ),
      and(eq(datasetAccessGrantsTable.status, "revoked"), lt(datasetAccessGrantsTable.revokedAt, datasetEndedCutoff)),
      and(eq(datasetAccessGrantsTable.status, "expired"), lt(datasetAccessGrantsTable.expiresAt, datasetEndedCutoff))
    );

  const datasetRequestIpHashCutoff = daysAgo(now, DATASET_REQUEST_IP_HASH_RETENTION_DAYS);
  const datasetGrantsStripPredicate = () =>
    and(
      isNotNull(datasetAccessGrantsTable.submitterIpHash),
      lt(datasetAccessGrantsTable.reviewedAt, datasetRequestIpHashCutoff)
    );

  const datasetDownloadsCutoff = daysAgo(now, DATASET_DOWNLOADS_RETENTION_DAYS);
  const datasetDownloadsDeletePredicate = () => lt(datasetDownloadsTable.createdAt, datasetDownloadsCutoff);

  const datasetDownloadIpHashCutoff = daysAgo(now, DATASET_DOWNLOAD_IP_HASH_RETENTION_DAYS);
  const datasetDownloadsStripPredicate = () =>
    and(isNotNull(datasetDownloadsTable.ipHash), lt(datasetDownloadsTable.createdAt, datasetDownloadIpHashCutoff));

  return [
    {
      table: "contact_messages",
      action: "delete",
      selectCandidates: () => getDb().select().from(contactMessagesTable).where(contactMessagesPredicate()),
      mutate: () => getDb().delete(contactMessagesTable).where(contactMessagesPredicate()).returning(),
    },
    {
      table: "leads",
      action: "delete",
      selectCandidates: () => getDb().select().from(leadsTable).where(leadsPredicate()),
      mutate: () => getDb().delete(leadsTable).where(leadsPredicate()).returning(),
    },
    {
      table: "submissions",
      action: "strip-ip-hash",
      selectCandidates: () => getDb().select().from(submissionsTable).where(submissionsPredicate()),
      mutate: () =>
        getDb()
          .update(submissionsTable)
          .set({ provenance: sql`${submissionsTable.provenance} - 'submitterIpHash'` })
          .where(submissionsPredicate())
          .returning(),
    },
    {
      table: "subscriptions",
      action: "delete",
      selectCandidates: () => getDb().select().from(subscriptionsTable).where(subscriptionsPredicate()),
      mutate: () => getDb().delete(subscriptionsTable).where(subscriptionsPredicate()).returning(),
    },
    {
      // Pseudonymized per-IP rate-limit counters for POST /api/subscribe. They
      // carry a salted IP hash and nothing else, and the cap window they feed
      // is one hour, so they age out fast — see SUBSCRIBE_ATTEMPTS_RETENTION_DAYS.
      table: "subscribe_attempts",
      action: "delete",
      selectCandidates: () => getDb().select().from(subscribeAttemptsTable).where(subscribeAttemptsPredicate()),
      mutate: () => getDb().delete(subscribeAttemptsTable).where(subscribeAttemptsPredicate()).returning(),
    },
    {
      // Pseudonymized per-IP rate-limit counters for the other four public
      // write surfaces (contribute / leads / contact / access-request) — exact
      // sibling of subscribe_attempts above, one row per admitted request,
      // carrying a salted IP hash and the surface name and nothing else. Same
      // 1h cap window, so the same short retention: see
      // INTAKE_ATTEMPTS_RETENTION_DAYS and `intakeAttemptsTable`'s doc comment.
      table: "intake_attempts",
      action: "delete",
      selectCandidates: () => getDb().select().from(intakeAttemptsTable).where(intakeAttemptsPredicate()),
      mutate: () => getDb().delete(intakeAttemptsTable).where(intakeAttemptsPredicate()).returning(),
    },
    {
      // "Email me when reviewed" requests. A submission that is never
      // reviewed otherwise leaves this row — and the address in it — sitting
      // forever; see SUBMISSION_NOTIFY_RETENTION_DAYS above. A reviewed
      // submission's row is already gone well before this window matters
      // (deleted immediately on send, per lib/submission-notify.ts), so this
      // step only ever catches the never-reviewed case.
      table: "submission_notify_requests",
      action: "delete",
      selectCandidates: () => getDb().select().from(submissionNotifyRequestsTable).where(submissionNotifyPredicate()),
      mutate: () => getDb().delete(submissionNotifyRequestsTable).where(submissionNotifyPredicate()).returning(),
    },
    {
      // Persistent per-address send-attempt counter for the "email me when
      // reviewed" cap (see submissionNotifySendsTable's doc comment in
      // lib/db/schema.ts). Retained well past the 30-day cap window
      // (SUBMISSION_NOTIFY_SENDS_RETENTION_DAYS = 60) so pruning can never
      // shorten the cap itself.
      table: "submission_notify_sends",
      action: "delete",
      selectCandidates: () =>
        getDb().select().from(submissionNotifySendsTable).where(submissionNotifySendsPredicate()),
      mutate: () =>
        getDb().delete(submissionNotifySendsTable).where(submissionNotifySendsPredicate()).returning(),
    },
    {
      // Outbound-send accountability log (see emailSendsTable's doc comment
      // in lib/db/schema.ts). Retained well past the 30-day confirm-cap
      // window (EMAIL_SENDS_RETENTION_DAYS = 180) so pruning can never
      // shorten the cap. Salted hashes only, so the backup line holds no address.
      table: "email_sends",
      action: "delete",
      selectCandidates: () => getDb().select().from(emailSendsTable).where(emailSendsPredicate()),
      mutate: () => getDb().delete(emailSendsTable).where(emailSendsPredicate()).returning(),
    },
    {
      table: "api_access_grants",
      action: "delete",
      selectCandidates: () => getDb().select().from(apiAccessGrantsTable).where(apiAccessGrantsPredicate()),
      mutate: () => getDb().delete(apiAccessGrantsTable).where(apiAccessGrantsPredicate()).returning(),
    },
    {
      table: "api_daily_usage",
      action: "delete",
      selectCandidates: () => getDb().select().from(apiDailyUsageTable).where(apiDailyUsagePredicate()),
      mutate: () => getDb().delete(apiDailyUsageTable).where(apiDailyUsagePredicate()).returning(),
    },
    // Dataset sharing. ORDER MATTERS: downloads are deleted BEFORE the grants that own them, so a
    // download a grant delete would cascade away has already been backed up by its own step. An ended
    // grant is >= 365 d past its end and downloads are only logged while a grant is active, so every
    // cascaded download is itself >= 365 d old — the cascade never removes a log row younger than the
    // notice promises (pinned by the invariant test). The two strip steps run last so they only see
    // rows that survived the deletes.
    {
      table: "dataset_downloads",
      action: "delete",
      selectCandidates: () => getDb().select().from(datasetDownloadsTable).where(datasetDownloadsDeletePredicate()),
      mutate: () => getDb().delete(datasetDownloadsTable).where(datasetDownloadsDeletePredicate()).returning(),
    },
    {
      table: "dataset_access_grants",
      action: "delete",
      selectCandidates: () => getDb().select().from(datasetAccessGrantsTable).where(datasetGrantsDeletePredicate()),
      mutate: () => getDb().delete(datasetAccessGrantsTable).where(datasetGrantsDeletePredicate()).returning(),
    },
    {
      table: "dataset_downloads",
      action: "strip-ip-hash",
      selectCandidates: () => getDb().select().from(datasetDownloadsTable).where(datasetDownloadsStripPredicate()),
      mutate: () =>
        getDb()
          .update(datasetDownloadsTable)
          .set({ ipHash: null })
          .where(datasetDownloadsStripPredicate())
          .returning(),
    },
    {
      table: "dataset_access_grants",
      action: "strip-ip-hash",
      selectCandidates: () => getDb().select().from(datasetAccessGrantsTable).where(datasetGrantsStripPredicate()),
      mutate: () =>
        getDb()
          .update(datasetAccessGrantsTable)
          .set({ submitterIpHash: null })
          .where(datasetGrantsStripPredicate())
          .returning(),
    },
  ];
}

const BACKUP_NAME_RE = /^retention-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/;

/**
 * Deletes retention backup files older than RETENTION_BACKUP_RETENTION_DAYS.
 * Fail-closed scope: immediate entries only; names must match exactly what
 * runRetentionPrune writes; the age comes from the name, never mtime; only
 * regular files (lstat — a symlink or directory is never deleted). Never throws.
 */
export function pruneRetentionBackups(backupDir: string, now: Date, apply: boolean): RetentionBackupsOutcome {
  let names: string[];
  try {
    const dirStat = lstatSync(backupDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      return {
        candidates: 0,
        deleted: 0,
        error: "retention backup dir is a symlink or not a directory; refusing to prune",
      };
    }
    names = readdirSync(backupDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { candidates: 0, deleted: 0 };
    return { candidates: 0, deleted: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const cutoff = daysAgo(now, RETENTION_BACKUP_RETENTION_DAYS).getTime();
  let candidates = 0;
  let deleted = 0;
  const errors: string[] = [];
  for (const name of names) {
    const m = BACKUP_NAME_RE.exec(name);
    if (!m) continue;
    const ts = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`).getTime();
    if (Number.isNaN(ts) || !(ts < cutoff)) continue;
    const file = path.join(backupDir, name);
    try {
      if (!lstatSync(file).isFile()) continue;
      candidates += 1;
      if (apply) {
        unlinkSync(file);
        deleted += 1;
      }
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors.length > 0 ? { candidates, deleted, error: errors.join("; ") } : { candidates, deleted };
}

/**
 * Core, DB-agnostic entry point — testable against PGlite (see
 * retention-prune.integration.test.ts) because it only ever calls `getDb()`,
 * never constructs a client itself.
 */
export async function runRetentionPrune(options: RetentionRunOptions): Promise<RetentionRunSummary> {
  const now = options.now ?? new Date();
  const apply = options.apply;
  const backupDir = options.backupDir ?? path.join("discovery-logs", "retention-backups");
  const backupPath = apply
    ? path.join(backupDir, `retention-${now.toISOString().replace(/[:.]/g, "-")}.jsonl`)
    : null;

  const steps = buildSteps(now);
  const tables: RetentionTableOutcome[] = [];
  for (const step of steps) {
    tables.push(await runStep(step, { apply, backupPath }));
  }

  const backups = pruneRetentionBackups(backupDir, now, apply);

  return {
    dryRun: !apply,
    backupPath,
    tables,
    backups,
    ok: tables.every((t) => t.error === undefined) && backups.error === undefined,
  };
}

function printSummary(summary: RetentionRunSummary): void {
  console.log(
    summary.dryRun
      ? "\nDRY RUN — nothing written. Re-run with --apply to publish."
      : "\nApplied."
  );
  if (summary.backupPath) {
    console.log(`Backup file: ${summary.backupPath}`);
  }
  for (const t of summary.tables) {
    const line = `  ${t.table} [${t.action}]: ${t.candidates} candidate(s), ${t.applied} applied`;
    console.log(t.error ? `${line} — FAILED: ${t.error}` : line);
    if (summary.dryRun && t.sampleIds.length > 0) {
      console.log(`    sample ids: ${t.sampleIds.join(", ")}`);
    }
  }
  const b = summary.backups;
  const bLine = `  retention-backups [delete files older than ${RETENTION_BACKUP_RETENTION_DAYS}d]: ${b.candidates} candidate(s), ${b.deleted} deleted`;
  console.log(b.error ? `${bLine} — FAILED: ${b.error}` : bLine);
  console.log(summary.ok ? "\nOK" : "\nFAILED — see per-table errors above.");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before running the retention pruner."
    );
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const summary = await runRetentionPrune({ apply });
  printSummary(summary);
  process.exit(summary.ok ? 0 : 1);
}

// Only run the CLI when this file is executed directly (e.g. `tsx
// retention-prune.ts`), not when `runRetentionPrune` is imported by the test
// suite — matches scripts/export.ts's isMain guard.
const isMain = isEntrypoint(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(formatFatalError(err));
    process.exit(1);
  });
}
