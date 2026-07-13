import { getAllFacilities } from "@/lib/data";
import { filterFacilities, type FacilityFilters } from "@/lib/filters";
import { STATUS_ORDER, type Status } from "@/lib/status";
import { facilityTypeEnum, type Facility } from "@/lib/schema";
import { jsonResponse, corsPreflight } from "@/lib/api-response";

/** Splits comma-separated/repeated query values into a flat, trimmed, non-empty list. */
function collectParam(searchParams: URLSearchParams, key: string): string[] {
  return searchParams
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Public facility list, filterable via query params. Lenient on invalid
 * filter tokens (public read API — silently drops rather than 400s) so
 * malformed client input degrades to "no constraint" instead of an error.
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  const statuses = collectParam(searchParams, "status").filter((s): s is Status =>
    (STATUS_ORDER as readonly string[]).includes(s)
  );
  const facilityTypes = collectParam(searchParams, "type").filter(
    (t): t is Facility["facilityType"] =>
      (facilityTypeEnum.options as readonly string[]).includes(t)
  );
  const states = collectParam(searchParams, "state");
  const operators = collectParam(searchParams, "operator");
  const query = searchParams.get("q") ?? undefined;

  const filters: FacilityFilters = {
    states,
    facilityTypes,
    operators,
    statuses,
    query,
  };

  const facilities = filterFacilities(await getAllFacilities(), filters);
  return jsonResponse({ count: facilities.length, facilities });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
