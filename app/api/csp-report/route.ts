import { extractTrustedClientIp, normaliseIpForBucketing } from "@/lib/rate-limit";
import {
  MAX_CSP_REPORT_BYTES,
  checkCspReportGlobalLimit,
  checkCspReportRateLimit,
  isExtensionNoise,
  logCspReport,
  normaliseCspReports,
} from "@/lib/csp-report";

/** 429 with an empty body — this endpoint never returns anything readable. */
function tooManyReports(retryAfter: number): Response {
  return new Response(null, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}

/**
 * Receiver for the `report-uri` directive on the enforcing CSP in
 * `next.config.ts`. Unauthenticated by necessity — the browser sends these,
 * not the app — so it is deliberately minimal: bounded body, per-IP rate
 * limit, no database write, no reflected content, and a 204 with an empty
 * body on every accepted request.
 *
 * Intentionally NOT wrapped in `jsonResponse`/`corsPreflight`
 * (`lib/api-response.ts`): those exist for the public *read* API and attach
 * `Access-Control-Allow-Origin: *`. A CSP report is a same-origin browser
 * side channel that is not subject to CORS at all, so advertising cross-origin
 * access here would widen the surface for nothing.
 *
 * The endpoint's own value is only realised if reports actually arrive, and
 * a report endpoint nobody posts to is indistinguishable from a clean site —
 * the exact trap #236 spent two sessions in. `e2e/csp.spec.ts` therefore
 * asserts delivery mechanically: it provokes a real violation in a real
 * browser and waits for the POST to land here.
 */
export async function POST(request: Request): Promise<Response> {
  const ip = normaliseIpForBucketing(extractTrustedClientIp(request.headers));

  // Per-IP first, then the all-callers ceiling — and the first failure must
  // SHORT-CIRCUIT, not merely win. A request already rejected on its own
  // bucket has to leave the shared budget untouched, or one noisy IP would
  // spend the global allowance on requests it was never going to be served,
  // starving every other visitor's reports.
  const ipGate = checkCspReportRateLimit(ip);
  if (!ipGate.ok) return tooManyReports(ipGate.retryAfter);

  const globalGate = checkCspReportGlobalLimit();
  if (!globalGate.ok) return tooManyReports(globalGate.retryAfter);

  // Checked twice on purpose. `content-length` lets an oversized body be
  // rejected before it is read, but it is caller-supplied and may be absent
  // or a lie, so the actual decoded size is checked again below — the header
  // is an optimisation, never the bound.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSP_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response(null, { status: 400 });
  }

  if (new TextEncoder().encode(raw).length > MAX_CSP_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }

  for (const report of normaliseCspReports(body)) {
    if (isExtensionNoise(report)) continue;
    logCspReport(report);
  }

  return new Response(null, { status: 204 });
}
