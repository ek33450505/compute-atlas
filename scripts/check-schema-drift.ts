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
 * It was found by hand, by querying `information_schema`. (The check now lists
 * tables via `pg_catalog.pg_tables`, which the role's grants do not filter.)
 * This script is the missing signal, meant to be run by hand or on a schedule.
 *
 * Unlike the retired JSON-vs-Neon drift check (non-blocking, always exited 0,
 * treated an unreachable DB as "nothing to report"), this script
 * FAILS CLOSED on purpose:
 *   - an expected table, column, index or NOT NULL flag missing/different -> hard failure, exit 1
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
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import { formatErrorSummary } from "../lib/db-error";
import * as schema from "../lib/db/schema";
import { getDb, hasDatabaseUrl } from "../lib/db/client";
import { isEntrypoint } from "./is-entrypoint";

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

export interface ExpectedColumn {
  /** "table.column" */
  key: string;
  notNull: boolean;
}

export interface ExpectedTableShape {
  columns: ExpectedColumn[];
  /** Named indexes, unique constraints and hand-managed indexes, as "table: name". */
  indexes: { table: string; name: string }[];
  /**
   * Foreign keys, as "table: name". Column-level `.references()` carries no explicit name;
   * Drizzle names it `<table>_<cols>_<foreign table>_<foreign cols>_fk` (ForeignKey.getName),
   * matching the CONSTRAINT names in drizzle/*.sql, then cut to Postgres's 63-byte identifier
   * limit (the DB stores the truncated name). Read from pg_constraint, not pg_class.
   */
  foreignKeys: { table: string; name: string }[];
}

/**
 * Indexes the code relies on that Drizzle's schema does not declare (hand-written
 * in a migration), so getTableConfig() cannot see them. A missing one FAILS the
 * check, same as a declared index.
 */
export const HAND_MANAGED_INDEXES: { table: string; name: string; migration: string; why: string }[] = [
  {
    table: "subscriptions",
    name: "subscriptions_active_target_idx",
    migration: "drizzle/0004_icy_monster_badoon.sql",
    why: "partial unique index (WHERE status <> 'unsubscribed'); the watch double-opt-in design depends on it",
  },
  {
    table: "facilities",
    name: "facilities_search_vector_idx",
    migration: "drizzle/0003_facilities_search_vector.sql",
    why: "GIN index over facilities.search_vector; lib/search-db.ts full-text search relies on it",
  },
];

const PG_MAX_IDENTIFIER_BYTES = 63;

/** Longest prefix of whole code points that fits 63 UTF-8 bytes (Postgres clips on a character boundary). */
export function toPgIdentifier(name: string): string {
  let bytes = 0;
  let out = "";
  for (const ch of name) {
    const len = Buffer.byteLength(ch);
    if (bytes + len > PG_MAX_IDENTIFIER_BYTES) break;
    bytes += len;
    out += ch;
  }
  return out;
}

/**
 * Derives expected columns (name + NOT NULL) and named indexes / unique
 * constraints from every pgTable export via `getTableConfig`, for the same
 * no-hand-maintained-list reason as getExpectedTableNames().
 */
export function getExpectedShape(): ExpectedTableShape {
  const columns: ExpectedColumn[] = [];
  const indexes: { table: string; name: string }[] = [];
  const foreignKeys: { table: string; name: string }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    for (const col of cfg.columns) {
      columns.push({ key: `${cfg.name}.${col.name}`, notNull: col.notNull });
    }
    for (const idx of cfg.indexes) {
      if (idx.config.name) indexes.push({ table: cfg.name, name: idx.config.name });
    }
    // Column-level `.unique()` is not in uniqueConstraints; it lands in the DB
    // as a constraint (and backing index) named `uniqueName` (`<table>_<col>_unique`).
    // PgColumn's constructor always fills uniqueName, but the type is `string | undefined`,
    // so the guard stays to satisfy the compiler.
    for (const col of cfg.columns) {
      if (col.isUnique && col.uniqueName) indexes.push({ table: cfg.name, name: col.uniqueName });
    }
    for (const fk of cfg.foreignKeys) foreignKeys.push({ table: cfg.name, name: toPgIdentifier(fk.getName()) });
    for (const uc of cfg.uniqueConstraints) {
      const name = uc.name;
      if (name) indexes.push({ table: cfg.name, name });
    }
  }
  for (const h of HAND_MANAGED_INDEXES) indexes.push({ table: h.table, name: h.name });
  columns.sort((a, b) => a.key.localeCompare(b.key));
  indexes.sort((a, b) => a.name.localeCompare(b.name));
  foreignKeys.sort((a, b) => a.name.localeCompare(b.name));
  return { columns, indexes, foreignKeys };
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
  /** "table.column" expected by the code but absent from a present table. */
  missingColumns: string[];
  /** Expected NOT NULL but nullable in the DB, or the reverse ("table.column: expected ..."). */
  nullabilityMismatches: string[];
  /** Named indexes / unique constraints the code declares that the DB lacks ("table: name"). */
  missingIndexes: string[];
  /** Info only, never a failure: columns/indexes in the DB that the code does not declare. */
  extraColumns: string[];
  extraIndexes: string[];
  /** null when api_daily_usage itself is missing — already covered by missingTables. */
  capLiveness: CapLivenessResult | null;
}

/** Thrown when an expected table, column, index or nullability is missing/different. The hard-failure path. */
export class SchemaDriftError extends Error {
  readonly report: SchemaDriftReport;

  constructor(report: SchemaDriftReport) {
    const parts: string[] = [];
    if (report.missingTables.length > 0) {
      parts.push(`${report.missingTables.length} table(s) missing: ${report.missingTables.join(", ")}`);
    }
    if (report.missingColumns.length > 0) {
      parts.push(`${report.missingColumns.length} column(s) missing: ${report.missingColumns.join(", ")}`);
    }
    if (report.nullabilityMismatches.length > 0) {
      parts.push(
        `${report.nullabilityMismatches.length} nullability mismatch(es): ` +
          report.nullabilityMismatches.join(", ")
      );
    }
    if (report.missingIndexes.length > 0) {
      parts.push(`${report.missingIndexes.length} index(es) missing: ${report.missingIndexes.join(", ")}`);
    }
    super(`Schema drift against the live database: ${parts.join("; ")}`);
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
  today: string = utcDateString(),
  expectedShape: ExpectedTableShape = getExpectedShape()
): Promise<SchemaDriftReport> {
  const db = getDb();

  // pg_catalog.pg_tables, not information_schema.tables: the latter lists only
  // tables the role holds a privilege on, so a least-privilege monitor role
  // (scripts/ops/create-ci-monitor-role.ts) would see a false "missing table".
  const { rows } = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'`
  );
  const present = new Set(rows.map((r) => r.tablename));

  const presentTables = expectedTables.filter((t) => present.has(t));
  const missingTables = expectedTables.filter((t) => !present.has(t));

  // Columns and indexes come from pg_catalog (pg_attribute / pg_class /
  // pg_namespace), which Postgres exposes to every role without any table
  // privilege (only the *contents* of tables are privilege-gated), so the
  // least-privilege monitor role needs no new grant. Columns of a missing table
  // are not also reported as missing columns: the table is the root cause.
  const colRows = (
    await db.execute<{ tablename: string; attname: string; attnotnull: boolean }>(sql`
      SELECT c.relname AS tablename, a.attname, a.attnotnull
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
    `)
  ).rows;
  const idxRows = (
    await db.execute<{ indexname: string }>(sql`
      SELECT c.relname AS indexname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('i', 'I')
    `)
  ).rows;

  const fkRows = (
    await db.execute<{ tablename: string; conname: string }>(sql`
      SELECT c.relname AS tablename, k.conname
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND k.contype = 'f'
    `)
  ).rows;

  const liveCols = new Map(colRows.map((r) => [`${r.tablename}.${r.attname}`, r.attnotnull]));
  const liveIdx = new Set(idxRows.map((r) => r.indexname));
  const expectedColKeys = new Set(expectedShape.columns.map((c) => c.key));
  const expectedIdxNames = new Set(expectedShape.indexes.map((i) => i.name));
  const missingTableSet = new Set(missingTables);

  const missingColumns: string[] = [];
  const nullabilityMismatches: string[] = [];
  for (const col of expectedShape.columns) {
    if (missingTableSet.has(col.key.slice(0, col.key.indexOf(".")))) continue;
    const liveNotNull = liveCols.get(col.key);
    if (liveNotNull === undefined) {
      missingColumns.push(col.key);
    } else if (liveNotNull !== col.notNull) {
      nullabilityMismatches.push(
        `${col.key}: expected ${col.notNull ? "NOT NULL" : "nullable"}, found ${liveNotNull ? "NOT NULL" : "nullable"}`
      );
    }
  }
  const liveFks = new Set(fkRows.map((r) => `${r.tablename}: ${r.conname}`));
  const missingIndexes = [
    ...expectedShape.indexes
      .filter((i) => !missingTableSet.has(i.table) && !liveIdx.has(i.name))
      .map((i) => `${i.table}: ${i.name}`),
    ...expectedShape.foreignKeys
      .filter((f) => !missingTableSet.has(f.table) && !liveFks.has(`${f.table}: ${f.name}`))
      .map((f) => `${f.table}: ${f.name}`),
  ];

  // Info only: extras in the DB (e.g. a manual hotfix index) never fail the run.
  // Scoped to expected tables so unrelated public-schema tables stay out of it.
  const expectedTableSet = new Set(expectedTables);
  const extraColumns = [...liveCols.keys()]
    .filter((k) => expectedTableSet.has(k.slice(0, k.indexOf("."))) && !expectedColKeys.has(k))
    .sort();
  const extraIndexes = [...liveIdx]
    .filter((n) => !expectedIdxNames.has(n) && !n.endsWith("_pkey"))
    .sort();

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

  const report: SchemaDriftReport = {
    expectedTables,
    presentTables,
    missingTables,
    missingColumns,
    nullabilityMismatches,
    missingIndexes,
    extraColumns,
    extraIndexes,
    capLiveness,
  };

  if (
    missingTables.length > 0 ||
    missingColumns.length > 0 ||
    nullabilityMismatches.length > 0 ||
    missingIndexes.length > 0
  ) {
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
  console.log("✓ All expected columns, nullability and named indexes match.");
  if (report.extraColumns.length > 0) {
    console.log(`info: ${report.extraColumns.length} column(s) in the DB not declared in code: ${report.extraColumns.join(", ")}`);
  }
  if (report.extraIndexes.length > 0) {
    console.log(`info: ${report.extraIndexes.length} index(es) in the DB not declared in code: ${report.extraIndexes.join(", ")}`);
  }

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

function printDrift(report: SchemaDriftReport): void {
  const groups: [string, string[]][] = [
    ["expected table(s) missing", report.missingTables],
    ["expected column(s) missing", report.missingColumns],
    ["nullability mismatch(es)", report.nullabilityMismatches],
    ["expected index(es) / unique / foreign key constraint(s) missing", report.missingIndexes],
  ];
  for (const [label, items] of groups) {
    if (items.length === 0) continue;
    console.error(`::error::Schema drift: ${items.length} ${label} in the live database:`);
    for (const name of items) {
      console.error(`   - ${name}`);
    }
  }
  console.error(
    "\nThis usually means a Drizzle migration was generated but never applied to this database " +
      "(`npm run db:migrate`, run against the correct DATABASE_URL, is a manual step — nothing in " +
      "CI/CD applies migrations). This is exactly the failure mode that left two of PR #222's tables " +
      "absent from production while CI stayed green and every API route kept returning 200."
  );
}

async function main(): Promise<void> {
  // Fail CLOSED — deliberately the opposite of the retired check-neon-drift.ts's
  // graceful exit-0 (a non-blocking convenience diff); this check exists
  // specifically because "can't check" was silently treated as "nothing to
  // see" at the request-path layer. It must not repeat that here.
  if (!hasDatabaseUrl()) {
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(
        "::error::DATABASE_URL is not set; the schema check cannot verify the deployed schema."
      );
    }
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example). This check fails " +
        "closed rather than skipping — unlike the retired drift check, an unconfigured/unreachable " +
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
      printDrift(err.report);
      process.exit(1);
    }
    // Log only the message (not the raw error object) so a Neon/pg connection
    // error can't echo the DB host/DSN into this public repo's Actions logs —
    // same precaution as the retired check-neon-drift.ts. Unlike it, this still
    // exits non-zero: an unreachable DB is a real failure to check, not a no-op.
    console.error(
      "::error::schema drift check errored:",
      formatErrorSummary(err)
    );
    process.exit(1);
  }
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches scripts/sync-to-neon.ts's isMain guard.
const isMain = isEntrypoint(import.meta.url);
if (isMain) {
  main();
}
