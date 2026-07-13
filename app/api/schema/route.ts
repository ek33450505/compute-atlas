import { z } from "zod";
import { facilitySchema } from "@/lib/schema";
import { jsonResponse, corsPreflight } from "@/lib/api-response";

/** Public JSON Schema export of the facility shape, for API consumers. */
export async function GET(): Promise<Response> {
  try {
    return jsonResponse(z.toJSONSchema(facilitySchema));
  } catch {
    // discriminated-union + superRefine can trip toJSONSchema's strict mode
    // on some zod versions — degrade to a best-effort schema rather than 500.
    try {
      return jsonResponse(z.toJSONSchema(facilitySchema, { unrepresentable: "any" }));
    } catch {
      return jsonResponse({ error: "Schema unavailable" }, { status: 500 });
    }
  }
}

export function OPTIONS(): Response {
  return corsPreflight();
}
