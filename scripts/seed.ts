/**
 * Seeds Neon Postgres from the canonical data/facilities.json snapshot.
 * Idempotent: upserts on `id`, so safe to re-run after edits to the JSON.
 *
 * Run via: npm run db:seed  (requires DATABASE_URL in .env.local)
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, which is a Next.js/tsconfig-plugin feature, not a Node runtime one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { facilitiesSchema } from "../lib/schema";
import { facilitiesTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { docToRow } from "../lib/db/serialize";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before seeding."
    );
    process.exit(1);
  }

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  const facilities = facilitiesSchema.parse(JSON.parse(raw));

  const db = getDb();

  for (const facility of facilities) {
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

  console.log(`Seeded ${facilities.length} facilities`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
