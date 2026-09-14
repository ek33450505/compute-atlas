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
 * This script NEVER edits, deletes, or "fixes" anything — recovery requires
 * manual intervention (deleting the row in Neon by hand). Reporting is the
 * only action.
 *
 * Run: npx tsx --env-file=.env.local scripts/discovery/check-digest-status.ts
 *      (local, reads .env.local; there is no package.json shortcut for this
 *      script yet, unlike check:drift/check:heartbeat)
 * Or:  npx tsx scripts/discovery/check-digest-status.ts (CI, reads DATABASE_URL
 *       from env)
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { isNull } from "drizzle-orm";

import { getDb, hasDatabaseUrl } from "../../lib/db/client";
import { stateDigestRunsTable, type StateDigestRunRow } from "../../lib/db/schema";

// --- errors ---------------------------------------------------------------

/**
 * Thrown when one or more digest runs are incomplete (completedAt IS NULL).
 */
export class DigestCrashError extends Error {
  readonly rows: StateDigestRunRow[];

  constructor(rows: StateDigestRunRow[]) {
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
        `run crashed mid-send and left no way for the next run to know it happened. ` +
        `Recovery requires manual deletion of the row in Neon (see CLAUDE.md). ` +
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

// --- query -----------------------------------------------------------------

/**
 * Attempts to fetch incomplete digest runs from the database.
 *
 * Returns:
 *   - null if the table does not exist (expected in forks or pre-migration DBs)
 *   - an array (possibly empty) if the table exists
 *
 * Throws DigestCheckError if the database connection fails or a query error
 * occurs for some other reason.
 */
export async function fetchIncompleteRuns(): Promise<StateDigestRunRow[] | null> {
  const db = getDb();

  // Attempt to query. If the table doesn't exist (Postgres error code 42P01,
  // "undefined_table"), catch it and return null. Any other error is
  // unexpected and propagates. Check the driver's structured `.code` field
  // FIRST (the reliable signal — `NeonDbError` always carries the real
  // Postgres SQLSTATE there) and fall back to a message substring match only
  // as a belt-and-suspenders check, since relying on message text alone is
  // fragile to driver/message-format changes.
  try {
    const rows = await db.select().from(stateDigestRunsTable).where(isNull(stateDigestRunsTable.completedAt));
    return rows;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "42P01" || message.includes('relation "state_digest_runs" does not exist')) {
      return null;
    }
    // Any other error is unexpected — log it and fail.
    throw new DigestCheckError(`Failed to query state_digest_runs: ${message}`);
  }
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

  try {
    const incompleteRuns = await fetchIncompleteRuns();

    if (incompleteRuns === null) {
      // Table does not exist — the feature hasn't been deployed to this DB yet.
      // This is expected in forks or pre-migration deployments, and is NOT an error.
      console.log("✓ state_digest_runs table does not exist (feature not yet deployed to this DB).");
      process.exit(0);
      return;
    }

    if (incompleteRuns.length === 0) {
      // Table exists but is empty — the feature has never run, or all runs completed.
      console.log("✓ state_digest_runs table is empty or all runs completed (no crashed runs detected).");
      process.exit(0);
      return;
    }

    // At least one run is incomplete — this is a crash that needs reporting.
    throw new DigestCrashError(incompleteRuns);
  } catch (err) {
    if (err instanceof DigestCrashError) {
      console.error(`::error::${err.message}`);
      process.exit(1);
      return;
    }
    if (err instanceof DigestCheckError) {
      console.error(`::error::${err.message}`);
      process.exit(1);
      return;
    }
    // Log only the message (not the raw error object) so a Neon/pg connection
    // error can't echo the DB host/DSN into the public repo's Actions logs.
    console.error("::error::digest status check errored:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only run the CLI when this file is executed directly, not when imported
// by the test suite — matches the isMain guard used across this directory's
// other check-*/publish-*.ts scripts.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
