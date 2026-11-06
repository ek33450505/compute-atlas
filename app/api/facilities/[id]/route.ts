import { getFacilityById } from "@/lib/data";
import { notAvailable, jsonResponse, corsPreflight } from "@/lib/api-response";
import { bearerMatches, requireAdmin } from "@/lib/api-auth";
import { updateFacility, deleteFacility } from "@/lib/facility-write";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

/**
 * Admin-only single-facility lookup by id. Facility pages stay public and
 * citable; the per-record JSON would be a scraping shortcut (sitemap + JSON =
 * the dataset), and nothing in the site or pipeline calls it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  // Auth BEFORE the lookup: an anonymous caller gets the same 403 for every id,
  // so existence cannot be probed (no 404-vs-403 oracle).
  if (!bearerMatches(request, process.env.API_ADMIN_TOKEN)) {
    return notAvailable();
  }

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
  // jsonResponse (no-store), never cacheableJson: Cloudflare caches non-/admin
  // GETs without keying on Authorization.
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

// `admin`, NOT `read` — same mixed-path exception as `/api/facilities`: an
// GET, PATCH and DELETE are all bearer-gated now. One OPTIONS covers all three,
// so it must advertise the union (including Authorization) or a legitimate
// cross-origin bearer request fails at the preflight.
export function OPTIONS(): Response {
  return corsPreflight("admin");
}
