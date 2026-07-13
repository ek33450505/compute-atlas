import { getStats } from "@/lib/data";
import { jsonResponse, corsPreflight } from "@/lib/api-response";

/** Public aggregate dataset stats. */
export async function GET(): Promise<Response> {
  return jsonResponse(await getStats());
}

export function OPTIONS(): Response {
  return corsPreflight();
}
