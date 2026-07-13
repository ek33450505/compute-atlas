import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";

import * as schema from "@/lib/db/schema";

let cachedDb: NeonHttpDatabase<typeof schema> | undefined;

/**
 * Lazily-initialized, memoized Drizzle client over the Neon HTTP driver.
 *
 * Deliberately does NOT read `process.env.DATABASE_URL` at module scope —
 * importing this module must never throw when DATABASE_URL is unset, since
 * the app's JSON-fallback read path (later phases) imports it unconditionally.
 * The error only fires when a caller actually invokes `getDb()`.
 */
export function getDb(): NeonHttpDatabase<typeof schema> {
  if (cachedDb) {
    return cachedDb;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before using the database."
    );
  }

  cachedDb = drizzle(neon(url), { schema });
  return cachedDb;
}

export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
