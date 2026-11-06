// Dependency-free so client-reachable modules can import the caps without
// pulling in the DB client or next/cache (see lib/search-db.ts).

/** Hard cap on search query length, applied before the query reaches Postgres or a cache key. */
export const MAX_SEARCH_QUERY_LEN = 200;

/** Defensive cap on tokens per query (length is already capped at MAX_SEARCH_QUERY_LEN). */
export const MAX_SEARCH_TOKENS = 10;
