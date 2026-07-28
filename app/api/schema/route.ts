import { z } from "zod";
import { facilitySchema } from "@/lib/schema";
import { jsonResponse, cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { extractClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";

/** Public JSON Schema export of the facility shape, for API consumers. */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractClientIp(request));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

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
