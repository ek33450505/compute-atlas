import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import type { Facility } from "@/lib/schema";
import { getDb, hasDatabaseUrl } from "@/lib/db/client";
import { facilitiesTable } from "@/lib/db/schema";
import { rowToFacility } from "@/lib/db/serialize";

/** Hard cap on search query length, applied before the query reaches Postgres or a cache key. */
export const MAX_SEARCH_QUERY_LEN = 200;

/**
 * DB-powered full-text search over `facilities.search_vector` (see
 * drizzle/0003_facilities_search_vector.sql — a generated tsvector column
 * indexed with GIN, computed from name + operator + doc->>'notes').
 *
 * Deliberately parallel to, and NOT wired into, the existing Fuse.js
 * client-side search in lib/search.ts — that command-palette search stays
 * untouched. Where/whether to surface this in the UI is out of scope for
 * this phase.
 *
 * Uses `plainto_tsquery('english', query)` (not `websearch_to_tsquery` or
 * `to_tsquery`) — `plainto_tsquery` treats the input as plain text and
 * ignores special tsquery operator syntax the user might type, matching the
 * "modest, no UI wiring" scope of this phase (no query-syntax teaching burden).
 *
 * Results parse the `doc` jsonb column back to `Facility` via the same
 * `rowToFacility` used by every other DB read path in lib/data.ts — no
 * independent re-validation against the Facility Zod schema, consistent
 * with the rest of the DB read paths. `normalized` is expected already
 * trimmed/lowercased/length-capped by `searchFacilitiesDb` below.
 */
async function searchFacilitiesDbUncached(normalized: string): Promise<Facility[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(facilitiesTable)
    .where(
      sql`${facilitiesTable.searchVector} @@ plainto_tsquery('english', ${normalized})`
    )
    .orderBy(
      sql`ts_rank(${facilitiesTable.searchVector}, plainto_tsquery('english', ${normalized})) DESC`
    );

  return rows.map(rowToFacility);
}

/**
 * Cached, normalized-query entry point for facility full-text search — the
 * public `/api/search` route's main egress hole, since every distinct query
 * was previously an uncached DB hit. Returns `[]` when `DATABASE_URL` is
 * unset (mirrors `getRecentActivity`'s DB-only degrade in lib/data.ts) and
 * when `query` is empty/whitespace-only (an empty `plainto_tsquery` matches
 * nothing meaningfully and is worth short-circuiting before issuing a query
 * or acquiring a cache entry).
 *
 * The cache key is the trimmed query lowercased and capped at
 * `MAX_SEARCH_QUERY_LEN` — `plainto_tsquery` already lowercases/stems
 * server-side, so normalizing the key this way is safe (doesn't change which
 * rows match) and raises the cache-hit rate across case/whitespace variants
 * of the same search.
 *
 * Mirrors lib/data.ts's `process.env.VITEST` bypass around `unstable_cache`
 * (which needs the Next.js request-scoped cache context, absent under
 * vitest) — the 536-test suite runs with no DATABASE_URL, exercising the
 * `[]` short-circuit above, but this keeps the bypass in place for any test
 * that mocks `hasDatabaseUrl` to true.
 */
export async function searchFacilitiesDb(query: string): Promise<Facility[]> {
  const trimmed = query.trim();
  if (!trimmed || !hasDatabaseUrl()) {
    return [];
  }

  const normalized = trimmed.slice(0, MAX_SEARCH_QUERY_LEN).toLowerCase();

  return process.env.VITEST
    ? searchFacilitiesDbUncached(normalized)
    : unstable_cache(searchFacilitiesDbUncached, ["api-search", normalized], {
        revalidate: 600,
        tags: ["facilities"],
      })(normalized);
}
