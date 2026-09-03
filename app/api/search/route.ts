import { searchFacilitiesDb, MAX_SEARCH_QUERY_LEN } from "@/lib/search-db";
import { cacheableJson, corsPreflight, jsonResponse, READ_CACHE } from "@/lib/api-response";
import { extractClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

/**
 * Public full-text facility search over the DB `search_vector` (name +
 * operator + doc->>'notes'). Returns `{ count, facilities, query }`. An
 * empty/whitespace query or an unset DATABASE_URL both yield an empty result
 * set (handled inside `searchFacilitiesDb`), never an error — matching the
 * lenient public read API in `app/api/facilities/route.ts`. The echoed
 * `query` is length-capped to `MAX_SEARCH_QUERY_LEN` (case preserved, just
 * bounded) so a very long `q` can't bloat the cached response body now that
 * a successful response carries `Cache-Control: s-maxage=600`.
 *
 * The one empty result that must NOT be cached is a degraded one. When the DB
 * read throws, `searchFacilitiesDb` swallows it and reports `degraded: true`;
 * sending that `[]` through `cacheableJson` would pin "no matches" at the edge
 * for 600s fresh plus an hour of stale-while-revalidate, long after Neon
 * recovered — a two-second blip turned into an hour of broken search. So the
 * degraded case returns `no-store` instead. Every other empty result (empty
 * query, unset DATABASE_URL, a real query with no matches) is a true answer
 * and stays cached exactly as before.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractClientIp(request));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const { facilities, degraded } = await searchFacilitiesDb(query);
  const body = {
    count: facilities.length,
    facilities,
    query: query.slice(0, MAX_SEARCH_QUERY_LEN),
  };

  if (degraded) {
    return jsonResponse(body, { headers: { "Cache-Control": "no-store" } });
  }

  return cacheableJson(body, READ_CACHE.search);
}

export function OPTIONS(): Response {
  return corsPreflight();
}
