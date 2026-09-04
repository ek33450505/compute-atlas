import { z } from "zod";
import { facilitySchema } from "@/lib/schema";
import { jsonResponse, cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

/** Public JSON Schema export of the facility shape, for API consumers. */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  try {
    return cacheableJson(z.toJSONSchema(facilitySchema), READ_CACHE.schema);
  } catch {
    // discriminated-union + superRefine can trip toJSONSchema's strict mode
    // on some zod versions — degrade to a best-effort schema rather than 500.
    try {
      return cacheableJson(
        z.toJSONSchema(facilitySchema, { unrepresentable: "any" }),
        READ_CACHE.schema
      );
    } catch {
      return jsonResponse({ error: "Schema unavailable" }, { status: 500 });
    }
  }
}

export function OPTIONS(): Response {
  return corsPreflight();
}
