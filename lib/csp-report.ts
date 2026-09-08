/**
 * Collection logic for CSP violation reports, shared by the `report-uri`
 * directive in `next.config.ts` and the route that receives them
 * (`app/api/csp-report/route.ts`).
 *
 * Why this exists at all: the policy in `next.config.ts` is now ENFORCING.
 * Under report-only, a violation was cosmetic — nothing broke, and the only
 * cost of missing one was a quiet console line. Enforcing inverts that: a
 * violation is a subresource that did not load, i.e. a feature silently
 * broken for a real visitor. The report endpoint is what makes that
 * observable, and issue #236's whole history is a warning about the
 * alternative — "a silent console for a page nobody opened is
 * indistinguishable from a genuinely clean one".
 *
 * Deliberately free of `next/*` imports: `next.config.ts` imports
 * `CSP_REPORT_PATH` from here so the header and the route cannot drift
 * apart (same producer/validator-share-a-module reasoning as
 * `lib/cache-tags.ts`), and the config is evaluated by Next's own loader
 * before the app graph exists.
 */

/**
 * Path the `report-uri` directive points at, and the directory this route
 * lives in. Guarded by `next.config.test.ts`, which asserts the directive
 * names exactly this value — a typo here would produce an endpoint nothing
 * ever posts to, which looks exactly like "no violations".
 */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * Hard cap on an accepted report body. A real `application/csp-report`
 * payload is well under 2 KB; the only field that can grow is
 * `original-policy` (the whole header, echoed back), which this module
 * discards. 16 KB leaves generous headroom while bounding what an
 * unauthenticated caller can make the function parse.
 */
export const MAX_CSP_REPORT_BYTES = 16_384;

/**
 * Per-IP fixed window. Set well above what a genuinely broken page produces
 * (a browser coalesces repeat violations of the same directive on the same
 * document) but low enough that this endpoint can't be used as a free log
 * amplifier.
 */
export const CSP_REPORT_LIMIT_MAX = 20;
export const CSP_REPORT_LIMIT_WINDOW_MS = 60_000;

/**
 * Hard ceiling on tracked IP buckets, enforced by FIFO eviction on the
 * new-IP insertion path — same shape and rationale as `MAX_BUCKETS` in
 * `lib/api-rate-limit.ts`. Deliberately a SEPARATE map from that module's:
 * sharing one would let a browser reporting a broken page burn that
 * visitor's public read-API budget, coupling two unrelated surfaces.
 */
export const MAX_CSP_REPORT_BUCKETS = 10_000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window check for `ip`. Takes `now` so tests can advance time
 * deterministically rather than faking timers (mirrors `checkApiRateLimit`).
 */
export function checkCspReportRateLimit(
  ip: string,
  now: number = Date.now()
): { ok: boolean; retryAfter: number } {
  const existing = buckets.get(ip);
  if (!existing || now - existing.windowStart >= CSP_REPORT_LIMIT_WINDOW_MS) {
    if (!existing && buckets.size >= MAX_CSP_REPORT_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(ip, { count: 1, windowStart: now });
    return { ok: true, retryAfter: 0 };
  }

  existing.count++;
  if (existing.count <= CSP_REPORT_LIMIT_MAX) {
    return { ok: true, retryAfter: 0 };
  }

  const retryAfter = Math.ceil((existing.windowStart + CSP_REPORT_LIMIT_WINDOW_MS - now) / 1000);
  return { ok: false, retryAfter };
}

/** Test-only: clears bucket state between cases. */
export function __resetCspReportRateLimit(): void {
  buckets.clear();
}

/** Test-only: current bucket count, to verify the FIFO ceiling holds. */
export function __cspReportBucketCount(): number {
  return buckets.size;
}

/** The subset of a violation report worth keeping. */
export interface NormalisedCspReport {
  /** Pathname only — a full `document-uri` can carry query strings. */
  documentPath: string;
  violatedDirective: string;
  effectiveDirective: string;
  blockedUri: string;
  sourceFile: string;
  lineNumber: number | null;
  columnNumber: number | null;
  disposition: string;
  /** Browsers already cap this at 40 chars; re-capped here regardless. */
  scriptSample: string;
}

const MAX_FIELD_CHARS = 200;
const MAX_SAMPLE_CHARS = 40;
/** One page can only violate so many distinct directives; bounds a hostile batch. */
const MAX_REPORTS_PER_REQUEST = 10;

function str(value: unknown, max: number = MAX_FIELD_CHARS): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reduces a `document-uri` to its pathname. Query strings on this site are
 * filter state rather than anything sensitive, but a report endpoint is the
 * wrong place to accumulate arbitrary caller-supplied URLs in logs, and the
 * path alone is what identifies the broken route.
 */
function toPath(value: unknown): string {
  const raw = str(value, 2_000);
  if (!raw) return "unknown";
  try {
    return new URL(raw).pathname.slice(0, MAX_FIELD_CHARS);
  } catch {
    // Relative or malformed — keep it, truncated, rather than dropping the
    // one field that says which page broke.
    return raw.slice(0, MAX_FIELD_CHARS);
  }
}

/**
 * Accepts BOTH wire formats, even though only `report-uri` is currently
 * advertised:
 *
 *  - `report-uri` → `application/csp-report`, a single object under a
 *    `csp-report` key with hyphenated field names.
 *  - `report-to`/`Reporting-Endpoints` → `application/reports+json`, an
 *    array of envelopes with camelCase `body` fields.
 *
 * Supporting the second costs a few lines now and means adopting
 * `Reporting-Endpoints` later is a header change with no endpoint change.
 * Unrecognised shapes yield `[]` rather than throwing — this endpoint is
 * unauthenticated and must not be a crash surface.
 */
export function normaliseCspReports(body: unknown): NormalisedCspReport[] {
  if (Array.isArray(body)) {
    return body
      .slice(0, MAX_REPORTS_PER_REQUEST)
      .filter(
        (entry): entry is { type?: unknown; body?: unknown } =>
          !!entry && typeof entry === "object"
      )
      .filter((entry) => entry.type === undefined || entry.type === "csp-violation")
      .map((entry) => fromReportingApi(entry.body))
      .filter((r): r is NormalisedCspReport => r !== null);
  }

  if (body && typeof body === "object" && "csp-report" in body) {
    const inner = (body as { "csp-report": unknown })["csp-report"];
    const one = fromReportUri(inner);
    return one ? [one] : [];
  }

  return [];
}

function fromReportUri(inner: unknown): NormalisedCspReport | null {
  if (!inner || typeof inner !== "object") return null;
  const r = inner as Record<string, unknown>;
  return {
    documentPath: toPath(r["document-uri"]),
    violatedDirective: str(r["violated-directive"]),
    effectiveDirective: str(r["effective-directive"]),
    blockedUri: str(r["blocked-uri"]),
    sourceFile: str(r["source-file"]),
    lineNumber: num(r["line-number"]),
    columnNumber: num(r["column-number"]),
    disposition: str(r["disposition"]),
    scriptSample: str(r["script-sample"], MAX_SAMPLE_CHARS),
  };
}

function fromReportingApi(inner: unknown): NormalisedCspReport | null {
  if (!inner || typeof inner !== "object") return null;
  const r = inner as Record<string, unknown>;
  return {
    documentPath: toPath(r.documentURL),
    violatedDirective: str(r.effectiveDirective),
    effectiveDirective: str(r.effectiveDirective),
    blockedUri: str(r.blockedURL),
    sourceFile: str(r.sourceFile),
    lineNumber: num(r.lineNumber),
    columnNumber: num(r.columnNumber),
    disposition: str(r.disposition),
    scriptSample: str(r.sample, MAX_SAMPLE_CHARS),
  };
}

/**
 * URL schemes that mean "a browser extension did this, not the site".
 *
 * Filtering these is not fussiness — extension-injected scripts and styles
 * are the dominant source of CSP reports on any public site, and a signal
 * this endpoint exists to surface (one real broken subresource) would be
 * unfindable underneath them. Matched as scheme PREFIXES, so there is no
 * host-substring ambiguity of the kind CodeQL flags as
 * `js/incomplete-url-substring-sanitization`.
 */
const EXTENSION_SCHEMES = [
  "chrome-extension:",
  "moz-extension:",
  "safari-extension:",
  "safari-web-extension:",
  "ms-browser-extension:",
  "edge-extension:",
  "webkit-masked-url:",
];

/**
 * Non-URL `blocked-uri` values browsers emit for things outside the page's
 * control (translation widgets, injected `about:blank` frames, reports whose
 * origin the browser declined to disclose). Compared exactly, not by
 * substring: `"about"` is a complete blocked-URI value, whereas a substring
 * test would also swallow a real `https://about.example.com/x.js`.
 */
const NON_ACTIONABLE_BLOCKED_URIS = new Set(["about", "asset", "invalid", "null", ""]);

/** True when a report is browser-extension noise rather than a site defect. */
export function isExtensionNoise(report: NormalisedCspReport): boolean {
  const candidates = [report.blockedUri, report.sourceFile];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (EXTENSION_SCHEMES.some((scheme) => lower.startsWith(scheme))) return true;
  }
  return NON_ACTIONABLE_BLOCKED_URIS.has(report.blockedUri.toLowerCase());
}

/**
 * Emits one structured line per actionable report. `console.warn` rather
 * than a table: these should be rare enough to read, a write path would give
 * an unauthenticated caller a way to grow the database, and Vercel's log
 * search over a stable `"csp-violation"` marker is enough to find them.
 */
export function logCspReport(report: NormalisedCspReport): void {
  console.warn(
    JSON.stringify({
      event: "csp-violation",
      path: report.documentPath,
      directive: report.effectiveDirective || report.violatedDirective,
      blocked: report.blockedUri,
      source: report.sourceFile,
      line: report.lineNumber,
      column: report.columnNumber,
      disposition: report.disposition,
      sample: report.scriptSample,
    })
  );
}
