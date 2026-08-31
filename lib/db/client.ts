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

/**
 * Gate for READ paths only — write/mutation/script call sites must keep
 * using `hasDatabaseUrl()` directly and must NOT switch to this predicate.
 *
 * Why this exists: Vercel's Neon integration provisions a fresh ephemeral
 * Neon branch for every preview deployment, and a preview build prerenders
 * ~1,500 routes against it. Measured August 2026: ~317 GB/month (40% of
 * total Neon egress) came from preview-branch reads alone, with a single
 * preview branch moving 1.9 GB. Preview deployments don't need live data —
 * `data/facilities.json` is refreshed by a near-daily automated `neon-sync`
 * PR, so it is at most ~1 day stale, and the JSON-fallback render path
 * already exists and is exercised locally (`DATABASE_URL= npm run dev`).
 *
 * Returns `false` on a Vercel preview deployment (`VERCEL_ENV === "preview"`)
 * so read paths fall back to the bundled JSON snapshot instead of hitting
 * Neon, UNLESS `PREVIEW_USE_DB=1` is set on that deployment as an explicit
 * per-preview escape hatch (e.g. to verify a DB-touching change before merge).
 * Otherwise defers to `hasDatabaseUrl()` — production, local dev, and CI
 * behave exactly as before.
 */
export function readsUseDatabase(): boolean {
  if (process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_USE_DB !== "1") {
    return false;
  }
  return hasDatabaseUrl();
}
