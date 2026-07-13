import { getFacilityById } from "@/lib/data";
import { jsonResponse, corsPreflight } from "@/lib/api-response";

/** Public single-facility lookup by id. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const facility = await getFacilityById(id);
  if (!facility) {
    return jsonResponse({ error: "Facility not found", id }, { status: 404 });
  }
  return jsonResponse(facility);
}

export function OPTIONS(): Response {
  return corsPreflight();
}
