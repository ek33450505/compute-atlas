import { getStats } from "@/lib/data";
import { getDatasetEdition } from "@/lib/dataset-edition";
import { cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { extractClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";

/**
 * Public aggregate dataset stats. Additive `edition` key carries the
 * dataset's citable identity (version/asOf/recordCount/schemaVersion) —
 * see `lib/dataset-edition.ts`. Existing fields and caching are unchanged.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractClientIp(request));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);
  const stats = await getStats();
  return cacheableJson(
    { ...stats, edition: getDatasetEdition() },
    READ_CACHE.stats
  );
}

export function OPTIONS(): Response {
  return corsPreflight();
}
