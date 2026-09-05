/**
 * One-time (or idempotent-rerun) backfill that upgrades any pre-hashing raw
 * token values left in the DB to their sha256 hash, matching lib/token-hash.ts.
 * DRY RUN IS THE DEFAULT: with no flags this only SELECTs and reports
 * per-column candidate counts — nothing is written. Pass --apply to hash in
 * place. Follows scripts/retention-prune.ts's CLI style.
 *
 * No backup file: unlike retention-prune's deletes, this transform is
 * derivable-forward and non-destructive to functionality. Every outstanding
 * raw confirm/access link keeps working after the backfill runs, because
 * every lookup call site (lib/subscribe.ts, lib/access-grants.ts,
 * lib/api-daily-limit.ts) hashes the PRESENTED token before comparing — a row
 * moving from raw to hashed storage is transparent to any caller still
 * holding the original raw link.
 *
 * Columns touched: subscriptions.confirm_token, api_access_grants.confirm_token,
 * api_access_grants.access_token. NEVER subscriptions.unsubscribe_token — that
 * column is deliberately kept raw (see its comment in lib/db/schema.ts)
 * because lib/notify.ts must embed it, readable, in every future alert email.
 *
 * Idempotent: a row already holding a 64-hex sha256 digest (isHashedToken) is
 * excluded from candidates on every run, so re-running after a partial apply
 * is always safe.
 *
 * Run: npx tsx --env-file=.env.local scripts/hash-tokens-backfill.ts            (dry run)
 *      npx tsx --env-file=.env.local scripts/hash-tokens-backfill.ts --apply   (writes)
 *
 * Uses relative imports, matching scripts/retention-prune.ts.
 */
import { eq, isNotNull } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import { apiAccessGrantsTable, subscriptionsTable } from "../lib/db/schema";
import { hashToken, isHashedToken } from "../lib/token-hash";

export interface BackfillColumnOutcome {
  table: string;
  column: string;
  candidates: number;
  applied: number;
}

export interface BackfillRunOptions {
  apply: boolean;
}

export interface BackfillRunSummary {
  dryRun: boolean;
  columns: BackfillColumnOutcome[];
  ok: boolean;
}

interface BackfillRow {
  id: string;
  value: string | null;
}

// Non-generic on purpose, mirroring scripts/retention-prune.ts's
// RetentionStep — each of the three steps below targets a different table,
// so a single `for...of` over a union of typed steps doesn't distribute
// cleanly through TypeScript.
interface BackfillStep {
  table: string;
  column: string;
  selectRows: () => Promise<BackfillRow[]>;
  updateRow: (id: string, hashed: string) => Promise<void>;
}

function buildSteps(): BackfillStep[] {
  return [
    {
      table: "subscriptions",
      column: "confirm_token",
      selectRows: () =>
        getDb()
          .select({ id: subscriptionsTable.id, value: subscriptionsTable.confirmToken })
          .from(subscriptionsTable),
      updateRow: async (id, hashed) => {
        await getDb()
          .update(subscriptionsTable)
          .set({ confirmToken: hashed })
          .where(eq(subscriptionsTable.id, id));
      },
    },
    {
      table: "api_access_grants",
      column: "confirm_token",
      selectRows: () =>
        getDb()
          .select({ id: apiAccessGrantsTable.id, value: apiAccessGrantsTable.confirmToken })
          .from(apiAccessGrantsTable),
      updateRow: async (id, hashed) => {
        await getDb()
          .update(apiAccessGrantsTable)
          .set({ confirmToken: hashed })
          .where(eq(apiAccessGrantsTable.id, id));
      },
    },
    {
      table: "api_access_grants",
      column: "access_token",
      // accessToken is nullable (null until a grant is confirmed) — excluded
      // at the SQL layer rather than left for the isHashedToken filter below.
      selectRows: () =>
        getDb()
          .select({ id: apiAccessGrantsTable.id, value: apiAccessGrantsTable.accessToken })
          .from(apiAccessGrantsTable)
          .where(isNotNull(apiAccessGrantsTable.accessToken)),
      updateRow: async (id, hashed) => {
        await getDb()
          .update(apiAccessGrantsTable)
          .set({ accessToken: hashed })
          .where(eq(apiAccessGrantsTable.id, id));
      },
    },
  ];
}

async function runStep(step: BackfillStep, apply: boolean): Promise<BackfillColumnOutcome> {
  const rows = await step.selectRows();
  const candidates = rows.filter(
    (row): row is BackfillRow & { value: string } => row.value !== null && !isHashedToken(row.value)
  );

  const outcome: BackfillColumnOutcome = {
    table: step.table,
    column: step.column,
    candidates: candidates.length,
    applied: 0,
  };

  if (!apply) {
    return outcome;
  }

  for (const row of candidates) {
    await step.updateRow(row.id, hashToken(row.value));
    outcome.applied += 1;
  }

  return outcome;
}

/**
 * Core, DB-agnostic entry point — testable against PGlite (see
 * hash-tokens-backfill.integration.test.ts) because it only ever calls
 * getDb(), never constructs a client itself. Mirrors runRetentionPrune's shape.
 */
export async function runHashTokensBackfill(options: BackfillRunOptions): Promise<BackfillRunSummary> {
  const steps = buildSteps();
  const columns: BackfillColumnOutcome[] = [];
  for (const step of steps) {
    columns.push(await runStep(step, options.apply));
  }

  return {
    dryRun: !options.apply,
    columns,
    ok: true,
  };
}

function printSummary(summary: BackfillRunSummary): void {
  console.log(
    summary.dryRun
      ? "\nDRY RUN — nothing written. Re-run with --apply to hash in place."
      : "\nApplied."
  );
  for (const c of summary.columns) {
    console.log(`  ${c.table}.${c.column}: ${c.candidates} candidate(s), ${c.applied} applied`);
  }
  console.log(summary.ok ? "\nOK" : "\nFAILED.");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before running the token-hash backfill."
    );
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const summary = await runHashTokensBackfill({ apply });
  printSummary(summary);
  process.exit(summary.ok ? 0 : 1);
}

// Only run the CLI when this file is executed directly (e.g. `tsx
// hash-tokens-backfill.ts`), not when `runHashTokensBackfill` is imported by
// the test suite — matches scripts/retention-prune.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
