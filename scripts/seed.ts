/**
 * Seeds Neon Postgres from the canonical data/facilities.json snapshot.
 *
 * Insert-new-safe by default: ids present in the JSON but absent from the DB
 * are always inserted. Ids that already exist in Neon are left untouched
 * unless `--force` is passed, in which case they're upserted from the JSON
 * (the old always-upsert behavior). This guards against a plain `db:seed`
 * silently reverting live Neon edits that have drifted ahead of the JSON
 * snapshot.
 *
 * Run via: npm run db:seed            (insert-new-safe; existing rows untouched)
 *          npm run db:seed -- --force (also overwrites existing rows from JSON)
 * (requires DATABASE_URL in .env.local)
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, which is a Next.js/tsconfig-plugin feature, not a Node runtime one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { facilitiesSchema } from "../lib/schema";
import type { Facility } from "../lib/schema";
import { facilitiesTable, facilityHistoryTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { docToRow } from "../lib/db/serialize";
import { computeDocDiff } from "../lib/doc-diff";

export interface SeedResult {
  /** Ids present in the JSON but absent from the DB — always inserted. */
  insertedCount: number;
  /** Ids present in both JSON and DB, left untouched (default mode only). */
  skippedExistingCount: number;
  /** Ids present in both JSON and DB, overwritten from JSON (--force only). */
  forcedOverwriteCount: number;
  /** Ids present in the DB but absent from the JSON — informational only, never modified. */
  neonOnlyCount: number;
  forced: boolean;
}

/**
 * Core seed logic, factored out of main() so it's testable against a PGlite
 * instance without going through the CLI/file-read path (see seed.test.ts).
 * Calls getDb() internally, matching lib/facility-write.ts's pattern —
 * tests mock ../lib/db/client rather than injecting a db param.
 */
export async function seedFacilities(
  facilities: Facility[],
  options: { force: boolean } = { force: false }
): Promise<SeedResult> {
  const db = getDb();

  const existingRows = await db.select({ id: facilitiesTable.id }).from(facilitiesTable);
  const existing = new Set(existingRows.map((r) => r.id));

  const toInsert = facilities.filter((f) => !existing.has(f.id));
  const existingInJson = facilities.filter((f) => existing.has(f.id));

  // Always insert new ids. onConflictDoNothing() keeps this race-safe (e.g.
  // a concurrent seed run or a submission approved between the id-fetch
  // above and this insert) without ever touching an existing row's data.
  //
  // We record `facility_history` directly here (rather than going through
  // lib/facility-write.ts's recordFacilityHistory) because seed.ts is a
  // plain tsx CLI: facility-write.ts imports `revalidateTag` from
  // `next/cache` at module scope, which only resolves inside the Next.js
  // runtime and throws when imported from a bare Node/tsx process. Only
  // computeDocDiff (a pure module) is safe to reuse here. .returning() lets
  // us tell a real insert from a no-op conflict, so history is written only
  // for facilities that were actually inserted.
  for (const facility of toInsert) {
    const inserted = await db
      .insert(facilitiesTable)
      .values(docToRow(facility))
      .onConflictDoNothing()
      .returning({ id: facilitiesTable.id });
    if (inserted.length > 0) {
      try {
        await db.insert(facilityHistoryTable).values({
          facilityId: facility.id,
          changeType: "create",
          diff: computeDocDiff(null, facility),
          source: "db-seed",
        });
      } catch (err) {
        console.error("facility_history insert failed for %s (create):", facility.id, err);
      }
    }
  }

  // Only touch ids that already exist when explicitly forced — this is the
  // old always-upsert behavior, now opt-in. Deliberately does NOT write
  // history: a bulk --force reseed can touch hundreds of existing rows, and
  // flooding the activity feed with "facility updated" entries for a
  // routine reseed would drown out real edits. History here stays scoped to
  // create-on-new-insert only.
  if (options.force) {
    for (const facility of existingInJson) {
      const row = docToRow(facility);
      await db
        .insert(facilitiesTable)
        .values(row)
        .onConflictDoUpdate({
          target: facilitiesTable.id,
          set: {
            doc: row.doc,
            name: row.name,
            operator: row.operator,
            state: row.state,
            status: row.status,
            facilityType: row.facilityType,
            confidence: row.confidence,
            capacityOperationalMw: row.capacityOperationalMw,
            capacityPlannedMw: row.capacityPlannedMw,
            lat: row.lat,
            lon: row.lon,
            announcedDate: row.announcedDate,
            lastUpdated: row.lastUpdated,
            updatedAt: new Date(),
          },
        });
    }
  }

  const jsonIds = new Set(facilities.map((f) => f.id));
  let neonOnlyCount = 0;
  for (const id of existing) {
    if (!jsonIds.has(id)) neonOnlyCount++;
  }

  return {
    insertedCount: toInsert.length,
    skippedExistingCount: options.force ? 0 : existingInJson.length,
    forcedOverwriteCount: options.force ? existingInJson.length : 0,
    neonOnlyCount,
    forced: options.force,
  };
}

function parseForceFlag(): boolean {
  return process.argv.includes("--force");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before seeding."
    );
    process.exit(1);
  }

  const force = parseForceFlag();

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  const facilities = facilitiesSchema.parse(JSON.parse(raw));

  const result = await seedFacilities(facilities, { force });

  console.log(`Seeded: ${result.insertedCount} inserted (new).`);
  if (result.forced) {
    console.log(`${result.forcedOverwriteCount} existing rows overwritten.`);
  } else if (result.skippedExistingCount > 0) {
    console.log(
      `${result.skippedExistingCount} existing rows left untouched (re-run with --force to overwrite them from JSON).`
    );
  }
  if (result.neonOnlyCount > 0) {
    console.log(
      `FYI: ${result.neonOnlyCount} rows exist in Neon but are absent from the JSON (not modified).`
    );
  }

  process.exit(0);
}

// Only run the CLI when this file is executed directly (e.g. `tsx seed.ts`),
// not when `seedFacilities` is imported by the test suite — matches
// scripts/export.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
