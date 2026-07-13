import { getFacilityById } from "@/lib/data";
import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { updateFacility, deleteFacility } from "@/lib/facility-write";

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

/** Admin-only: patches a facility. Top-level shallow merge — see `updateFacility`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await updateFacility(id, body);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }
  return jsonResponse(result.facility);
}

/** Admin-only: deletes a facility. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const result = await deleteFacility(id);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }
  return jsonResponse({ deleted: true, id });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
