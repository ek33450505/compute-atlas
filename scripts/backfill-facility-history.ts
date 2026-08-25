/**
 * One-time, idempotent backfill: writes a `create` facility_history row for
 * every facility that currently has NO history row at all — the facilities
 * bulk-seeded by `db:seed` before scripts/seed.ts started emitting history
 * on insert (see scripts/seed.ts's insert loop). Only touches history-less
 * facilities, so re-running after a successful pass is always a no-op.
 *
 * `changedAt` is explicitly set to the facility's own `updatedAt` (its real
 * go-live timestamp) rather than "now", so backfilled entries slot into the
 * /activity feed at the date they actually went live, not all bunched at
 * the moment this script happens to run.
 *
 * ALREADY APPLIED — kept for reference, not part of any routine workflow.
 * This patched a hole that no longer exists: `db:seed` wrote no history, so
 * bulk-seeded facilities were invisible to /activity. `db:sync` (the only
 * bulk write path now) writes facility_history for every change, so nothing
 * new can arrive history-less. A re-run is a verified no-op.
 *
 * There is deliberately no npm alias. Run it directly if you ever need to:
 *   npx tsx --env-file=.env.local scripts/backfill-facility-history.ts --dry-run  (computes + logs only, writes nothing)
 *   npx tsx --env-file=.env.local scripts/backfill-facility-history.ts            (writes)
 * (requires DATABASE_URL in .env.local — i.e. it targets prod Neon)
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, which is a Next.js/tsconfig-plugin feature, not a Node runtime one.
 */
import { facilitiesTable, facilityHistoryTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { computeDocDiff } from "../lib/doc-diff";

export interface BackfillResult {
  /** Facilities that had no history row and got a backfilled `create` row (0 for --dry-run). */
  backfilledCount: number;
  /** Facilities that already had at least one history row — left untouched. */
  alreadyHadHistoryCount: number;
}

/**
 * Core backfill logic, factored out of main() so it's testable against a
 * PGlite instance without going through the CLI/env-var path (see
 * backfill-facility-history.test.ts). Calls getDb() internally, matching
 * scripts/seed.ts's pattern — tests mock ../lib/db/client rather than
 * injecting a db param.
 */
export async function backfillFacilityHistory(
  options: { dryRun: boolean } = { dryRun: false }
): Promise<BackfillResult> {
  const db = getDb();

  const historyRows = await db
    .select({ facilityId: facilityHistoryTable.facilityId })
    .from(facilityHistoryTable);
  const hasHistory = new Set(historyRows.map((r) => r.facilityId));

  const facilityRows = await db
    .select({
      id: facilitiesTable.id,
      doc: facilitiesTable.doc,
      updatedAt: facilitiesTable.updatedAt,
    })
    .from(facilitiesTable);

  const missing = facilityRows.filter((f) => !hasHistory.has(f.id));
  const alreadyHadHistoryCount = facilityRows.length - missing.length;

  if (options.dryRun) {
    console.log(
      `dry-run: would backfill ${missing.length} facilities (${alreadyHadHistoryCount} already have history).`
    );
    if (missing.length > 0) {
      console.log("Sample:", missing.slice(0, 5).map((f) => f.id).join(", "));
    }
    return { backfilledCount: 0, alreadyHadHistoryCount };
  }

  for (const facility of missing) {
    try {
      await db.insert(facilityHistoryTable).values({
        facilityId: facility.id,
        changeType: "create",
        diff: computeDocDiff(null, facility.doc),
        source: "db-seed-backfill",
        changedAt: facility.updatedAt,
      });
    } catch (err) {
      console.error("facility_history backfill insert failed for %s:", facility.id, err);
    }
  }

  return { backfilledCount: missing.length, alreadyHadHistoryCount };
}

function parseDryRunFlag(): boolean {
  return process.argv.includes("--dry-run");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before backfilling."
    );
    process.exit(1);
  }

  const dryRun = parseDryRunFlag();
  const result = await backfillFacilityHistory({ dryRun });

  if (dryRun) {
    console.log(
      `Dry run complete. ${result.alreadyHadHistoryCount} facilities already have history; nothing written.`
    );
  } else {
    console.log(
      `Backfilled ${result.backfilledCount} facilities. ${result.alreadyHadHistoryCount} already had history.`
    );
  }

  process.exit(0);
}

// Only run the CLI when this file is executed directly (e.g. `tsx
// backfill-facility-history.ts`), not when `backfillFacilityHistory` is
// imported by the test suite — matches scripts/seed.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
