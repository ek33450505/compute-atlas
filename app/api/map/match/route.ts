import { getAllFacilities } from "@/lib/data";
import { filterFacilities } from "@/lib/filters";
import { MATCHABLE_MIN_MW } from "@/lib/capacity-options";
import {
  cacheableJson,
  corsPreflight,
  jsonResponse,
  READ_CACHE,
} from "@/lib/api-response";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { checkDailyApiGate } from "@/lib/api-daily-limit";

/** Caps keep the endpoint from being a general-purpose query surface. */
export const MAX_OPERATORS = 25;
export const MAX_OPERATOR_LENGTH = 200;
const ALLOWED_KEYS = new Set(["operator", "minMw"]);

interface MatchQuery {
  operators: string[];
  minMw: number;
}

/**
 * Strict parse. Operators arrive as repeated `operator=` params (operator
 * names can contain commas, so a comma list would be ambiguous) and are
 * de-duplicated. `minMw` must be exactly one of the capacity popover's
 * non-zero values, in canonical form. Returns null for any other query key,
 * anything malformed or over a cap, or neither filter present.
 */
function parseQuery(url: URL): MatchQuery | null {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_KEYS.has(key)) return null;
  }

  const operators = [...new Set(url.searchParams.getAll("operator"))];
  if (operators.length > MAX_OPERATORS) return null;
  for (const op of operators) {
    if (op.length === 0 || op.length > MAX_OPERATOR_LENGTH) return null;
  }

  let minMw = 0;
  const rawMinMw = url.searchParams.getAll("minMw");
  if (rawMinMw.length > 1) return null;
  if (rawMinMw.length === 1) {
    if (!MATCHABLE_MIN_MW.includes(rawMinMw[0])) return null;
    minMw = Number(rawMinMw[0]);
  }

  // Without a filter this would list every id.
  if (operators.length === 0 && minMw === 0) return null;
  return { operators, minMw };
}

/**
 * Ids matching the operator / minimum-capacity filters. The /map client holds
 * only coordinates, so it asks here for the two filters it cannot evaluate
 * locally, then intersects with its own status/state/type filtering.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = checkApiRateLimit(extractTrustedClientIp(request.headers));
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const query = parseQuery(new URL(request.url));
  if (!query) return jsonResponse({ error: "Bad request" }, { status: 400 });

  const dailyGate = await checkDailyApiGate(request);
  if (!dailyGate.ok) return tooManyRequests(dailyGate.retryAfter ?? 60);

  const facilities = await getAllFacilities();
  const ids = filterFacilities(facilities, {
    operators: query.operators,
    minMw: query.minMw,
  }).map((f) => f.id);

  return cacheableJson({ ids }, READ_CACHE.mapMatch);
}

export function OPTIONS(): Response {
  return corsPreflight("read");
}
