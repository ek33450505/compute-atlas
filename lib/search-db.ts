import { sql } from "drizzle-orm";

import type { Facility } from "@/lib/schema";
import { getDb, hasDatabaseUrl } from "@/lib/db/client";
import { facilitiesTable } from "@/lib/db/schema";
import { rowToFacility } from "@/lib/db/serialize";

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
 * Returns `[]` when `DATABASE_URL` is unset (mirrors `getRecentActivity`'s
 * DB-only degrade in lib/data.ts) and when `query` is empty/whitespace-only
 * (an empty `plainto_tsquery` matches nothing meaningfully and is worth
 * short-circuiting before issuing a query).
 *
 * Results parse the `doc` jsonb column back to `Facility` via the same
 * `rowToFacility` used by every other DB read path in lib/data.ts — no
 * independent re-validation against the Facility Zod schema, consistent
 * with the rest of the DB read paths.
 */
export async function searchFacilitiesDb(query: string): Promise<Facility[]> {
  const trimmed = query.trim();
  if (!trimmed || !hasDatabaseUrl()) {
    return [];
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(facilitiesTable)
    .where(
      sql`${facilitiesTable.searchVector} @@ plainto_tsquery('english', ${trimmed})`
    )
    .orderBy(
      sql`ts_rank(${facilitiesTable.searchVector}, plainto_tsquery('english', ${trimmed})) DESC`
    );

  return rows.map(rowToFacility);
}
