import { searchFacilitiesDb } from "@/lib/search-db";
import { jsonResponse, corsPreflight } from "@/lib/api-response";

/**
 * Public full-text facility search over the DB `search_vector` (name +
 * operator + doc->>'notes'). Returns `{ count, facilities, query }`. An
 * empty/whitespace query or an unset DATABASE_URL both yield an empty result
 * set (handled inside `searchFacilitiesDb`), never an error — matching the
 * lenient public read API in `app/api/facilities/route.ts`.
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const facilities = await searchFacilitiesDb(query);
  return jsonResponse({ count: facilities.length, facilities, query });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
