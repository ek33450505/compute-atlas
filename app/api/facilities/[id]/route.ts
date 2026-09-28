import { getFacilityById } from "@/lib/data";
import { jsonResponse, cacheableJson, corsPreflight, READ_CACHE } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { updateFacility, deleteFacility } from "@/lib/facility-write";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

/** Public single-facility lookup by id. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  const { id } = await params;
  const facility = await getFacilityById(id);
  if (!facility) {
    // `no-store` by choice (Ed, 2026-09-28), not a leftover: the body is tiny, so
    // caching it would buy origin invocations, not the bandwidth this project is
    // actually capped on, and one rule for `jsonResponse` beats a per-site
    // exception. If bad-id enumeration ever shows up in the invocation numbers,
    // this 404 is the one to reconsider — a short window via `cacheableJson`.
    return jsonResponse({ error: "Facility not found", id }, { status: 404 });
  }
  return cacheableJson(facility, READ_CACHE.facility);
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

// `admin`, NOT `read` — same mixed-path exception as `/api/facilities`: an
// anonymous public GET above plus bearer-gated PATCH and DELETE. One OPTIONS
// covers all three, so it must advertise the union or a legitimate cross-origin
// bearer write fails at the preflight. As there, the GET's own 200 carries no
// method/header list — `cacheableJson` spreads `CORS_RESPONSE_HEADERS`, which
// is `Access-Control-Allow-Origin: *` alone — because both lists are
// preflight-only, so this scope reaches an OPTIONS and nothing else.
export function OPTIONS(): Response {
  return corsPreflight("admin");
}
