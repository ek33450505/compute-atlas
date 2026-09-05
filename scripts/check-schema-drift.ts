/**
 * Read-only schema-drift guard: fails LOUDLY when the deployed database's
 * schema doesn't match what the application code expects.
 *
 * Why this exists (a real incident, 2026-09-03): PR #222 shipped two Drizzle
 * migrations (`api_access_grants`, `api_daily_usage`). They were applied
 * locally but never run against production Neon — `db:migrate` is a manual
 * local command (`node --env-file=.env.local drizzle-kit migrate`) and
 * nothing in CI/CD applies migrations. Consequences: the daily API rate cap
 * caught the resulting DB error and *failed open* on every request, and
 * `POST /api/access/request` would have 500'd. Nothing surfaced it — CI was
 * green, the deploy succeeded, all four public API routes kept returning 200.
 * It was found by hand, by querying `information_schema`. This script is the
 * missing signal, meant to be run by hand or on a schedule.
 *
 * Unlike `scripts/check-neon-drift.ts` (deliberately non-blocking, always
 * exits 0, treats an unreachable DB as "nothing to report"), this script
 * FAILS CLOSED on purpose:
 *   - an expected table missing from the live database -> hard failure, exit 1
 *   - DATABASE_URL unset, or the DB unreachable          -> hard failure, exit 1
 * A monitor that silently passes when it cannot check is worse than no
 * monitor at all — that exact shape ("catch the DB error, fail open") is
 * what caused the incident above at the request-path layer. This script does
 * not repeat it at the monitoring layer.
 *
 * The one intentionally SOFT signal: `api_daily_usage` gains a row per
 * distinct client per UTC day when the read-API cap is doing its job. Zero
 * rows for today is only a WARNING — it may simply mean no traffic yet — and
 * never fails the run on its own.
 *
 * Run: npm run check:schema (local, reads .env.local)
 * Or:  npx tsx scripts/check-schema-drift.ts (CI, reads DATABASE_URL from env)
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { eq, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import * as schema from "../lib/db/schema";
import { getDb, hasDatabaseUrl } from "../lib/db/client";

/**
 * Derives the list of table names the CODE expects to exist straight from
 * every `pgTable(...)` export in lib/db/schema.ts, rather than a hand-
 * maintained array — so a future table is covered automatically and this
 * list can never silently drift from the schema file itself.
 */
export function getExpectedTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      names.push(getTableName(value));
    }
  }
  return names.sort();
}

/**
 * "YYYY-MM-DD" in UTC. Mirrors the private `utcDateString()` helper in
 * lib/api-daily-limit.ts (same format — that's the column this check reads)
 * but kept local rather than exporting across an ownership boundary for
 * this unit.
 */
function utcDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface CapLivenessResult {
  day: string;
  rowCount: number;
}

export interface SchemaDriftReport {
  expectedTables: string[];
  presentTables: string[];
  missingTables: string[];
  /** null when api_daily_usage itself is missing — already covered by missingTables. */
  capLiveness: CapLivenessResult | null;
}

/** Thrown when one or more expected tables are missing from the live database. The hard-failure path. */
export class SchemaDriftError extends Error {
  readonly report: SchemaDriftReport;

  constructor(report: SchemaDriftReport) {
    super(
      `Schema drift: ${report.missingTables.length} expected table(s) missing from the live ` +
        `database: ${report.missingTables.join(", ")}`
    );
    this.name = "SchemaDriftError";
    this.report = report;
  }
}

/**
 * Runs the read-only checks against whatever `getDb()` currently resolves to
 * — real Neon in prod/CI, a mocked PGlite instance in tests (same
 * indirection `scripts/sync-to-neon.ts` uses via `vi.mock("../lib/db/client")`).
 *
 * Throws `SchemaDriftError` when any expected table is missing. Never
 * fails open — a thrown error here is the correct, intended outcome of a
 * real drift, not a bug to catch-and-continue.
 */
export async function runSchemaDriftCheck(
  expectedTables: string[] = getExpectedTableNames(),
  today: string = utcDateString()
): Promise<SchemaDriftReport> {
  const db = getDb();

  const { rows } = await db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const present = new Set(rows.map((r) => r.table_name));

  const presentTables = expectedTables.filter((t) => present.has(t));
  const missingTables = expectedTables.filter((t) => !present.has(t));

  // Soft cap-liveness signal — only meaningful (and only queried) when the
  // table itself exists; a missing api_daily_usage is already covered above.
  let capLiveness: CapLivenessResult | null = null;
  const capTableName = getTableName(schema.apiDailyUsageTable);
  if (present.has(capTableName)) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.apiDailyUsageTable)
      .where(eq(schema.apiDailyUsageTable.day, today));
    capLiveness = { day: today, rowCount: row?.count ?? 0 };
  }

  const report: SchemaDriftReport = { expectedTables, presentTables, missingTables, capLiveness };

  if (missingTables.length > 0) {
    throw new SchemaDriftError(report);
  }

  return report;
}

function printReport(report: SchemaDriftReport): void {
  console.log(
    `Expected ${report.expectedTables.length} table(s) (derived from lib/db/schema.ts): ` +
      report.expectedTables.join(", ")
  );
  console.log(`✓ ${report.presentTables.length}/${report.expectedTables.length} present in the live database.`);

  if (report.capLiveness) {
    if (report.capLiveness.rowCount > 0) {
      console.log(
        `✓ api_daily_usage has ${report.capLiveness.rowCount} row(s) for ${report.capLiveness.day} ` +
          "(UTC) — the daily-cap gate is recording usage."
      );
    } else {
      console.log(
        `::warning::api_daily_usage exists but has 0 rows for ${report.capLiveness.day} (UTC). ` +
          "This may simply mean there has been no read-API traffic yet today — it is NOT, on its " +
          "own, evidence of a fault. If traffic is known to have occurred and this stays at 0 on a " +
          "re-check, the daily-cap gate (lib/api-daily-limit.ts) may be silently failing open."
      );
    }
  }
}

function printMissingTables(report: SchemaDriftReport): void {
  console.error(
    `::error::Schema drift: ${report.missingTables.length} expected table(s) missing from the ` +
      "live database:"
  );
  for (const name of report.missingTables) {
    console.error(`   - ${name}`);
  }
  console.error(
    "\nThis usually means a Drizzle migration was generated but never applied to this database " +
      "(`npm run db:migrate`, run against the correct DATABASE_URL, is a manual step — nothing in " +
      "CI/CD applies migrations). This is exactly the failure mode that left two of PR #222's tables " +
      "absent from production while CI stayed green and every API route kept returning 200."
  );
}

async function main(): Promise<void> {
  // Fail CLOSED — deliberately the opposite of check-neon-drift.ts's graceful
  // exit-0. That script is a non-blocking convenience diff; this one exists
  // specifically because "can't check" was silently treated as "nothing to
  // see" at the request-path layer. It must not repeat that here.
  if (!hasDatabaseUrl()) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example). This check fails " +
        "closed rather than skipping — unlike `npm run check:drift`, an unconfigured/unreachable " +
        "database is treated as a failure to verify, not a pass."
    );
    process.exit(1);
  }

  try {
    const report = await runSchemaDriftCheck();
    printReport(report);
    console.log("\n✓ No schema drift detected.");
    process.exit(0);
  } catch (err) {
    if (err instanceof SchemaDriftError) {
      printMissingTables(err.report);
      process.exit(1);
    }
    // Log only the message (not the raw error object) so a Neon/pg connection
    // error can't echo the DB host/DSN into this public repo's Actions logs —
    // same precaution as check-neon-drift.ts. Unlike that script, this still
    // exits non-zero: an unreachable DB is a real failure to check, not a no-op.
    console.error(
      "::error::schema drift check errored:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches scripts/sync-to-neon.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
