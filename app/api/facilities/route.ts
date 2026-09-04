import { getAllFacilities } from "@/lib/data";
import { filterFacilities, type FacilityFilters } from "@/lib/filters";
import { STATUS_ORDER, type Status } from "@/lib/status";
import { facilityTypeEnum, type Facility } from "@/lib/schema";
import { jsonResponse, cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { createFacility } from "@/lib/facility-write";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";
import { MAX_SEARCH_QUERY_LEN } from "@/lib/search-db";

/**
 * Hard cap on values collected per query-param key. This does NOT bound
 * CDN cache-key cardinality — Vercel derives the cache key from the raw
 * request URL at the edge, before this app-side truncation ever runs. What
 * it bounds is APP-SIDE COMPUTE: an unbounded list of repeated/comma-
 * separated values (e.g. `?operator=a,b,c,...` thousands deep) would
 * otherwise blow up the filter work below on a single request. Origin load
 * from the resulting unique-URL cache misses is separately bounded by the
 * read-API rate limiter (`checkApiRateLimit`, which fires on cache misses —
 * see below).
 */
const MAX_PARAM_VALUES = 50;

/** Splits comma-separated/repeated query values into a flat, trimmed, non-empty, length-capped list. */
function collectParam(searchParams: URLSearchParams, key: string): string[] {
  return searchParams
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, MAX_PARAM_VALUES);
}

/**
 * Public facility list, filterable via query params. Lenient on invalid
 * filter tokens (public read API — silently drops rather than 400s) so
 * malformed client input degrades to "no constraint" instead of an error.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

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
  // Same app-side-compute-bounding reasoning as MAX_PARAM_VALUES above: cap
  // `q` to the same limit /api/search enforces (lib/search-db.ts) rather
  // than letting an unbounded/high-entropy value reach the filter work.
  const rawQuery = searchParams.get("q");
  const query = rawQuery ? rawQuery.slice(0, MAX_SEARCH_QUERY_LEN) : undefined;

  const filters: FacilityFilters = {
    states,
    facilityTypes,
    operators,
    statuses,
    query,
    // minMw (lib/filters.ts) is intentionally UI-only — not exposed as a public query param here.
  };

  const facilities = filterFacilities(await getAllFacilities(), filters);
  return cacheableJson({ count: facilities.length, facilities }, READ_CACHE.list);
}

/** Admin-only: creates a new facility. Requires `Authorization: Bearer <API_ADMIN_TOKEN>`. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await createFacility(body);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }
  return jsonResponse(result.facility, { status: 201 });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
