import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import type { Facility } from "@/lib/schema";
import { getDb, hasDatabaseUrl } from "@/lib/db/client";
import { facilitiesTable } from "@/lib/db/schema";
import { rowToFacility } from "@/lib/db/serialize";

/** Hard cap on search query length, applied before the query reaches Postgres or a cache key. */
export const MAX_SEARCH_QUERY_LEN = 200;

/** Defensive cap on tokens per query (length is already capped at MAX_SEARCH_QUERY_LEN). */
const MAX_SEARCH_TOKENS = 10;

/**
 * Turns a user query into an autocomplete-style tsquery string, or `null` when
 * the query carries no usable tokens.
 *
 * Splits on anything that isn't a Unicode letter or digit, so no tsquery
 * operator character (`&`, `|`, `!`, `:`, `(`, `)`, `*`, `'`) can survive into
 * the resulting expression. Complete words are ANDed; the LAST token gets the
 * `:*` prefix marker, because it is the one the user is still typing.
 *
 * Returns `null` for an empty/punctuation-only query: `to_tsquery('english','')`
 * raises a syntax error, so callers must short-circuit rather than issue it.
 */
export function buildTsQuery(normalized: string): string | null {
  const tokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS);

  if (tokens.length === 0) return null;

  return tokens
    .map((tok, i) => (i === tokens.length - 1 ? `${tok}:*` : tok))
    .join(" & ");
}

/**
 * DB-powered full-text search over `facilities.search_vector` (see
 * drizzle/0003_facilities_search_vector.sql — a generated tsvector column
 * indexed with GIN, computed from name + operator + doc->>'notes').
 *
 * Uses `to_tsquery('english', $1)` with a tsquery expression built by
 * `buildTsQuery` above, so a partial last word prefix-matches: typing "goo"
 * finds Google. `plainto_tsquery` (used previously) matches whole stemmed
 * words only — "googl" hit, "goog" missed — which is unusable for
 * as-you-type search. Injection safety does not come from `plainto_tsquery`
 * swallowing operator syntax any more; it comes from tokenizing the input to
 * alphanumeric runs (dropping every tsquery metacharacter) and binding the
 * result as a parameter, never concatenating it into the SQL text.
 *
 * This is the backing search for the command palette's facility results:
 * `SiteHeader` passes only operator + state entries to the client (see
 * lib/search-index.ts), and facilities come from `/api/search` → here.
 *
 * Results parse the `doc` jsonb column back to `Facility` via the same
 * `rowToFacility` used by every other DB read path in lib/data.ts — no
 * independent re-validation against the Facility Zod schema, consistent
 * with the rest of the DB read paths. `normalized` is expected already
 * trimmed/lowercased/length-capped by `searchFacilitiesDb` below.
 */
async function searchFacilitiesDbUncached(normalized: string): Promise<Facility[]> {
  const tsQuery = buildTsQuery(normalized);
  if (!tsQuery) {
    return [];
  }

  const db = getDb();
  // `.select({ doc: ... })` projects out only the jsonb doc — `search_vector`
  // itself (the ~24% of a full row's bytes discarded by rowToFacility below)
  // is still valid to filter/ORDER BY here even though it's not projected:
  // Postgres can WHERE/ORDER BY a column that isn't in the SELECT list.
  const rows = await db
    .select({ doc: facilitiesTable.doc })
    .from(facilitiesTable)
    .where(sql`${facilitiesTable.searchVector} @@ to_tsquery('english', ${tsQuery})`)
    .orderBy(
      sql`ts_rank(${facilitiesTable.searchVector}, to_tsquery('english', ${tsQuery})) DESC`
    );

  return rows.map(rowToFacility);
}

/**
 * Cached, normalized-query entry point for facility full-text search — the
 * public `/api/search` route's main egress hole, since every distinct query
 * was previously an uncached DB hit. Returns `[]` when `DATABASE_URL` is
 * unset (mirrors `getRecentActivity`'s DB-only degrade in lib/data.ts) and
 * when `query` is empty/whitespace-only. A query that survives the trim but
 * tokenizes to nothing (punctuation only) is short-circuited here too, before
 * the cache — `to_tsquery('english','')` is a syntax error, so it must never
 * be issued, and `searchFacilitiesDbUncached` keeps the same check as defence
 * in depth for any future direct caller.
 *
 * The cache key is the trimmed query lowercased and capped at
 * `MAX_SEARCH_QUERY_LEN` — `to_tsquery` already lowercases/stems
 * server-side, so normalizing the key this way is safe (doesn't change which
 * rows match) and raises the cache-hit rate across case/whitespace variants
 * of the same search.
 *
 * Mirrors lib/data.ts's `process.env.VITEST` bypass around `unstable_cache`
 * (which needs the Next.js request-scoped cache context, absent under
 * vitest) — the 536-test suite runs with no DATABASE_URL, exercising the
 * `[]` short-circuit above, but this keeps the bypass in place for any test
 * that mocks `hasDatabaseUrl` to true.
 *
 * The read is wrapped in a try/catch so a live DB failure (unreachable, or
 * over quota) degrades to `[]` — same pattern as `getRecentActivity` in
 * lib/data.ts. This is a PRE-EXISTING gap, not one introduced by the
 * to_tsquery switch: without it, a transient Neon failure surfaced on the
 * public, unauthenticated `/api/search` as a 500 while every other public
 * read path in this codebase degrades to empty. The catch sits OUTSIDE
 * `unstable_cache` deliberately — catching inside `searchFacilitiesDbUncached`
 * would cache the empty result for the full 600s revalidate window, turning a
 * momentary blip into ten minutes of empty search.
 *
 * That in-process guard is only half the job, which is why the return type
 * carries `degraded` rather than a bare array: an empty body handed to
 * `cacheableJson` is stamped `s-maxage=600, stale-while-revalidate=3600` and
 * pinned at Vercel's edge for the same ten minutes the `unstable_cache`
 * placement exists to avoid — the CDN would simply re-create the bug one
 * layer out. `degraded` keeps a blip's `[]` distinguishable from a genuine
 * "no matches" `[]` (which stays fully cacheable), and it is a required
 * property so a caller cannot silently drop it. See `app/api/search/route.ts`.
 */
export interface FacilitySearchResult {
  facilities: Facility[];
  /** True only when the DB read threw — never for a legitimately empty result. */
  degraded: boolean;
}

export async function searchFacilitiesDb(query: string): Promise<FacilitySearchResult> {
  const trimmed = query.trim();
  if (!trimmed || !hasDatabaseUrl()) {
    return { facilities: [], degraded: false };
  }

  const normalized = trimmed.slice(0, MAX_SEARCH_QUERY_LEN).toLowerCase();

  // Hoisted above the cache for consistency with the empty/whitespace guard
  // above: a query that tokenizes to nothing can't match anything, so it
  // shouldn't occupy a cache entry either. NOT a 500 fix — the inner check in
  // `searchFacilitiesDbUncached` already prevented `to_tsquery('english','')`
  // from ever being issued, and it stays there as defence in depth. The point
  // is that the asymmetry (one guard above the cache, its sibling below) is
  // what invites a later "tidy" to delete the wrong one.
  if (!buildTsQuery(normalized)) {
    return { facilities: [], degraded: false };
  }

  try {
    const facilities = await (process.env.VITEST
      ? searchFacilitiesDbUncached(normalized)
      : unstable_cache(searchFacilitiesDbUncached, ["api-search", normalized], {
          revalidate: 600,
          tags: ["facilities"],
        })(normalized));
    return { facilities, degraded: false };
  } catch (err) {
    // Visible to an operator in the logs (matching `getRecentActivity`), but
    // not to the caller — /api/search returns an empty result set rather than
    // a 500.
    console.warn("searchFacilitiesDb: facility search unavailable, degrading to empty", err);
    return { facilities: [], degraded: true };
  }
}
