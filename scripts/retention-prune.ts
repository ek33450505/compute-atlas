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
 *
 * Run: npm run retention:prune               (dry run — read-only, safe anytime)
 *      npm run retention:prune -- --apply    (writes — see safety contract above)
 *
 * Uses relative imports, matching scripts/check-neon-drift.ts and scripts/export.ts.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { and, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import {
  apiAccessGrantsTable,
  apiDailyUsageTable,
  contactMessagesTable,
  leadsTable,
  submissionsTable,
  subscriptionsTable,
} from "../lib/db/schema";

// --- retention windows -------------------------------------------------
// Single source of truth (scripts/discovery/run.sh's nightly lane points
// readers here rather than duplicating the numbers).
export const CONTACT_MESSAGES_RETENTION_DAYS = 180; // contact_messages: delete rows older than this many days (by createdAt)
export const LEADS_RETENTION_DAYS = 365; // leads: delete promoted/dismissed rows whose reviewedAt (falling back to createdAt) is older than this many days
export const SUBMISSIONS_IP_HASH_RETENTION_DAYS = 90; // submissions: strip provenance.submitterIpHash from reviewed (non-pending) rows older than this many days (by reviewedAt) — the submission row itself is never deleted
export const SUBSCRIPTIONS_UNSUBSCRIBED_RETENTION_DAYS = 30; // subscriptions: delete unsubscribed rows older than this many days (by unsubscribedAt)
export const API_ACCESS_GRANTS_RETENTION_DAYS = 90; // api_access_grants: delete revoked-or-expired rows older than this many days (by revokedAt/expiresAt)
export const API_DAILY_USAGE_RETENTION_DAYS = 35; // api_daily_usage: delete daily per-IP counters older than this many days (by the `day` text column)

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

export interface RetentionRunSummary {
  dryRun: boolean;
  backupPath: string | null;
  tables: RetentionTableOutcome[];
  ok: boolean;
}

// Non-generic on purpose: buildSteps() below returns six table-specific
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

  const apiAccessGrantsCutoff = daysAgo(now, API_ACCESS_GRANTS_RETENTION_DAYS);
  const apiAccessGrantsPredicate = () =>
    or(
      and(eq(apiAccessGrantsTable.status, "revoked"), lt(apiAccessGrantsTable.revokedAt, apiAccessGrantsCutoff)),
      and(isNotNull(apiAccessGrantsTable.expiresAt), lt(apiAccessGrantsTable.expiresAt, apiAccessGrantsCutoff))
    );

  const apiDailyUsageCutoffDay = utcDateString(daysAgo(now, API_DAILY_USAGE_RETENTION_DAYS));
  const apiDailyUsagePredicate = () => lt(apiDailyUsageTable.day, apiDailyUsageCutoffDay);

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
  ];
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

  return {
    dryRun: !apply,
    backupPath,
    tables,
    ok: tables.every((t) => t.error === undefined),
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
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
