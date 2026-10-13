import { buildNavSearchIndex } from "@/lib/search-index";
import { cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

/**
 * Public operator + state index for the ⌘K palette. Returns
 * `{ entries: SearchEntry[] }`. The palette fetches it once, on first open,
 * instead of receiving it as a prop — serializing ~1,200 entries into the RSC
 * payload of every prerendered route cost ~225 KB per page.
 *
 * The underlying `loadNavFacets` read refreshes on a 24h untagged timer, so
 * the response is cached at the edge for a day (`READ_CACHE.navIndex`).
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  // No degraded no-store branch (unlike /api/search): `loadFacilities` falls
  // back to the full JSON snapshot (`selectAllFacilitiesResilient`, lib/data.ts),
  // so a Neon outage serves complete data, never an empty list to cache.
  const entries = await buildNavSearchIndex();
  return cacheableJson({ entries }, READ_CACHE.navIndex);
}

// `read`: this path exports GET and nothing else, so its preflight has no
// reason to advertise a write verb or `Authorization`.
export function OPTIONS(): Response {
  return corsPreflight("read");
}
