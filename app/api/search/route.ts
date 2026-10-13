import { searchFacilitiesDb, MAX_SEARCH_QUERY_LEN } from "@/lib/search-db";
import { cacheableJson, corsPreflight, jsonResponse, READ_CACHE } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";
import { toFacilitySearchHit } from "@/lib/search";

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
 *
 * `?shape=palette` is an opt-in lean projection for the ⌘K palette: each
 * facility carries only the fields `facilityToSearchEntry` reads (see
 * `FacilitySearchHit`). It is projected here, after `searchFacilitiesDb`, so
 * both shapes share its server-side `unstable_cache` entry. The HTTP responses
 * differ, though: the CDN and Cloudflare key on the full URL, so each shape is
 * cached under its own URL. Absent or any other value keeps the full records,
 * byte-identical to the original public contract.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const { facilities, degraded } = await searchFacilitiesDb(query);
  const lean = searchParams.get("shape") === "palette";
  const body = {
    count: facilities.length,
    facilities: lean ? facilities.map(toFacilitySearchHit) : facilities,
    query: query.slice(0, MAX_SEARCH_QUERY_LEN),
  };

  if (degraded) {
    return jsonResponse(body, { headers: { "Cache-Control": "no-store" } });
  }

  return cacheableJson(body, READ_CACHE.search);
}

// `read`: this path exports GET and nothing else, so its preflight has no
// reason to advertise a write verb or `Authorization`.
export function OPTIONS(): Response {
  return corsPreflight("read");
}
