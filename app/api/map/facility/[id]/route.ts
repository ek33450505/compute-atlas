import { getFacilityByIdCached } from "@/lib/data";
import { toPopupSummary } from "@/lib/facility-slim";
import { getSitingContext } from "@/lib/siting-context";
import {
  cacheableJson,
  corsPreflight,
  jsonResponse,
  READ_CACHE,
} from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,199}$/;

/**
 * Click-time map popup summary: the slim, coordinate-free `PopupSummary` plus
 * siting context, fetched when a pin is opened so neither the full facility
 * record nor `data/siting-context.json` has to ship in the client bundle.
 * Malformed and unknown ids get the same 404 (id never echoed) and a malformed
 * id never reaches the loader.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const { id } = await params;
  const notFound = () => jsonResponse({ error: "Not found" }, { status: 404 });
  // Before the daily gate (a DB round trip): malformed ids cost only the
  // in-memory limiter.
  if (!SLUG_SHAPE.test(id)) return notFound();

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  const facility = await getFacilityByIdCached(id);
  if (!facility) return notFound();

  return cacheableJson(
    toPopupSummary(facility, getSitingContext(facility.id)),
    READ_CACHE.mapPopup
  );
}

export function OPTIONS(): Response {
  return corsPreflight("read");
}
