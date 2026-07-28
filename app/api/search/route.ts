import { searchFacilitiesDb, MAX_SEARCH_QUERY_LEN } from "@/lib/search-db";
import { cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { extractClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";

/**
 * Public full-text facility search over the DB `search_vector` (name +
 * operator + doc->>'notes'). Returns `{ count, facilities, query }`. An
 * empty/whitespace query or an unset DATABASE_URL both yield an empty result
 * set (handled inside `searchFacilitiesDb`), never an error — matching the
 * lenient public read API in `app/api/facilities/route.ts`. The echoed
 * `query` is length-capped to `MAX_SEARCH_QUERY_LEN` (case preserved, just
 * bounded) so a very long `q` can't bloat the cached response body now that
 * a successful response carries `Cache-Control: s-maxage=600`.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractClientIp(request));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const facilities = await searchFacilitiesDb(query);
  return cacheableJson(
    { count: facilities.length, facilities, query: query.slice(0, MAX_SEARCH_QUERY_LEN) },
    READ_CACHE.search
  );
}

export function OPTIONS(): Response {
  return corsPreflight();
}
