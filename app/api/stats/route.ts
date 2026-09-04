import { getStats } from "@/lib/data";
import { getLiveDatasetEdition } from "@/lib/dataset-edition";
import { cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

/**
 * Public aggregate dataset stats. `count` (from `getStats`) is a LIVE row
 * count, read fresh from Neon on every request. The additive `edition` key
 * carries the dataset's citable identity (version/asOf/schemaVersion) — see
 * `lib/dataset-edition.ts` — but deliberately omits `recordCount`: that field
 * describes the last published snapshot and can legitimately disagree with
 * the live `count` above, and stacking two different record totals in one
 * response with nothing marking them as different things is exactly the
 * citation defect this route used to have. Use `getLiveDatasetEdition`, not
 * `getDatasetEdition`, for that reason. Other fields and caching unchanged.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  const stats = await getStats();
  return cacheableJson(
    { ...stats, edition: getLiveDatasetEdition() },
    READ_CACHE.stats
  );
}

export function OPTIONS(): Response {
  return corsPreflight();
}
