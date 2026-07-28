import { getStats } from "@/lib/data";
import { cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { extractClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";

/** Public aggregate dataset stats. */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractClientIp(request));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);
  return cacheableJson(await getStats(), READ_CACHE.stats);
}

export function OPTIONS(): Response {
  return corsPreflight();
}
