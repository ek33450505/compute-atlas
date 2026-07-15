import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "@/lib/db/schema";
import { docToRow } from "@/lib/db/serialize";
import { facilitiesTable } from "@/lib/db/schema";
import type { Facility } from "@/lib/schema";

export type TestDb = PgliteDatabase<typeof schema>;

export interface TestDbHandle {
  db: TestDb;
  client: PGlite;
  /** Truncates all app tables (RESTART IDENTITY CASCADE) so tests isolate via truncate, not per-test spin-up. */
  reset: () => Promise<void>;
}

/**
 * Spins up one in-memory PGlite instance (real Postgres-wasm) per test file,
 * wraps it with drizzle, and applies every migration in drizzle/ so the
 * schema — including the hand-written 0003 generated tsvector column — is
 * live. PGlite is Postgres 15+, so to_tsvector/GIN/gen_random_uuid()/jsonb
 * all work identically to Neon.
 *
 * Intentionally NOT memoized/shared across files — each *.integration.test.ts
 * calls this once in beforeAll and truncates between tests via reset().
 */
export async function makeTestDb(): Promise<TestDbHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  try {
    await migrate(db, { migrationsFolder: "drizzle" });
  } catch (err) {
    // Fallback path (only exercised if the drizzle migrator ever chokes on
    // the hand-written 0003 generated-column migration): read the applied
    // migration files directly and run each statement via pglite.exec().
    console.warn(
      "drizzle pglite migrator failed, falling back to raw statement replay:",
      err
    );
    await replayMigrationsRaw(client);
  }

  const reset = async (): Promise<void> => {
    await client.exec(
      `TRUNCATE TABLE "facilities", "submissions", "facility_history" RESTART IDENTITY CASCADE`
    );
  };

  return { db, client, reset };
}

async function replayMigrationsRaw(client: PGlite): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf-8")
  ) as { entries: { tag: string }[] };

  for (const entry of journal.entries) {
    const sqlText = readFileSync(join(process.cwd(), "drizzle", `${entry.tag}.sql`), "utf-8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await client.exec(statement);
    }
  }
}

/** Inserts a seed facility via the same docToRow mapping the write primitives use. */
export async function seedFacility(db: TestDb, doc: Facility): Promise<void> {
  await db.insert(facilitiesTable).values(docToRow(doc));
}
