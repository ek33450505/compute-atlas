/**
 * Mechanical (no LLM) source-liveness checker. Walks every source URL across
 * the full facility dataset and probes it with a bounded-concurrency
 * HEAD-then-GET-fallback request, classifying the result. Purely a flag/report
 * tool — it never writes to data/facilities.json and never POSTs to
 * /api/submissions. Never reads response bodies beyond the status code.
 *
 * Run via: tsx scripts/discovery/check-sources.ts
 * Writes a report to discovery-logs/source-health-<timestamp>.json.
 *
 * Deliberately does NOT import submit-candidates.ts or lib/facility-write.ts.
 * The CLI facility-loading fallback comes from the shared leaf
 * ./load-facilities.ts (see that file's header for why it's a leaf, not an
 * import of submit-candidates.ts itself).
 *
 * The SSRF guard, retry/backoff constants, and bounded-concurrency runner are
 * shared with the candidate-source verification path and live in
 * ./net-guard.ts — this file imports them rather than redefining them.
 *
 * Uses relative imports throughout, matching scripts/seed.ts and scripts/discovery/submit-candidates.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BROWSER_HEADERS,
  RETRY_AFTER_CAP_MS,
  RETRY_BACKOFF_MS,
  defaultSleep,
  RESOLVER_FAILURE_CODES,
  createClosablePinnedFetch,
  createRateGate,
  isBlockedHost,
  isHttpUrl,
  isSsrfBlockedError,
  parseRetryAfterMs,
  resolveVetted,
  lookupFailureCode,
  runWithConcurrency,
  type ResolveDeps,
} from "./net-guard";
import { loadFacilities } from "./load-facilities";
import type { Facility } from "../../lib/schema";
import { isEntrypoint } from "../is-entrypoint";
import { formatFatalError, redactedErrorCode } from "../../lib/db-error";

// --- types -----------------------------------------------------------------

export type SourceClassification =
  | "ok"
  | "redirected"
  | "gone" // 404, 410, 451 — genuinely gone (machine-consumed downstream)
  | "bot_blocked" // 401, 403 — anti-bot, NOT dead
  | "throttled" // 429 — rate-limited, transient
  | "server_error" // 5xx
  | "client_error" // other 4xx
  | "timeout"
  | "error"
  | "blocked"; // SSRF-guard refusal — never re-used for anti-bot

export interface SourceCheckResult {
  facilityId: string;
  facilityName: string;
  url: string;
  sourceIndex: number;
  httpStatus: number | null;
  classification: SourceClassification;
  /** Identifier-shaped error code (`redactedErrorCode`) present on every
   * `error` classification (`"unknown"` when the error carries none), so a
   * report can tell a resolver outage (`EREFUSED`) from link rot (`ENOTFOUND`).
   * Absent on every other classification; never a message. */
  errorCode?: string;
  checkedAt: string;
}

export { RESOLVER_FAILURE_CODES };

/** Consecutive resolver failures that abort the lane. */
export const RESOLVER_OUTAGE_THRESHOLD = 25;

/** Consecutive probe timeouts that abort the lane. A resolver that silently
 * drops queries produces timeouts, not error codes, so the code-based breaker
 * cannot see it. */
export const TIMEOUT_OUTAGE_THRESHOLD = 50;

/** New DNS resolutions per second the lane may start (cache hits are free).
 * One resolution is two queries (A + AAAA), so 5/s is ~600 queries/min,
 * under a 1000/60 s per-client resolver limit even with an empty cache. */
export const LOOKUP_RATE_PER_SECOND = 5;

/** Thrown by {@link checkSources} when the resolver or network looks down; no report is written. */
export class ResolverOutageError extends Error {
  constructor(
    readonly code: string,
    readonly consecutive: number,
    readonly kind: "lookup" | "timeout" = "lookup",
  ) {
    super(
      kind === "lookup"
        ? `resolver outage: ${consecutive} consecutive lookup failures (${code})`
        : `${consecutive} consecutive probe timeouts (possible silent resolver or network drop)`,
    );
    this.name = "ResolverOutageError";
  }
}

export interface SourceCheckDeps {
  /** Defaults to a DNS-pinned fetch (see net-guard.ts), so the shortest call is the safe one. */
  fetchImpl?: typeof fetch;
  concurrency: number;
  timeoutMs: number;
  /** Max retry attempts for 429/5xx responses. Defaults to 2. */
  maxRetries?: number;
  /** Injectable sleep for retry backoff. Defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable DNS resolvers for the SSRF resolution check. Defaults to real DNS. */
  resolveDeps?: ResolveDeps;
  /** Cap on new DNS resolutions per second. Defaults to {@link LOOKUP_RATE_PER_SECOND}. */
  lookupsPerSecond?: number;
  /** Consecutive resolver failures that abort. Defaults to {@link RESOLVER_OUTAGE_THRESHOLD}. */
  outageThreshold?: number;
  /** Consecutive probe timeouts that abort. Defaults to {@link TIMEOUT_OUTAGE_THRESHOLD}. */
  timeoutThreshold?: number;
  /** Clock for the lookup rate gate (ms, monotonic). Defaults to `performance.now`. */
  nowImpl?: () => number;
}

interface SourceTask {
  facilityId: string;
  facilityName: string;
  url: string;
  sourceIndex: number;
}

// --- classification + probing -------------------------------------------

function classifyStatus(status: number): SourceClassification {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "redirected";
  if (status === 401 || status === 403) return "bot_blocked";
  if (status === 429) return "throttled";
  if (status === 404 || status === 410 || status === 451) return "gone";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "client_error";
}

/**
 * Whether a HEAD response warrants a second attempt with GET. Many CDNs and
 * municipal document servers answer HEAD with 404/403 while serving the very
 * same URL fine on GET — measured 2026-09-14 across the live dataset, 24 of
 * the 59 URLs this checker classified `gone` from a HEAD 404 returned 200 to
 * GET (all 8 deq.virginia.gov permits and all 4 constellationenergy.com press
 * releases among them, 3 of those the record's only primary source). Treating
 * a HEAD status as final is therefore a ~41% false-positive rate on the one
 * number this tool exists to report.
 *
 * Redirects keep their own `redirected` classification and must NOT be
 * re-fetched, and 429/5xx have a dedicated backoff-retry path below that owns
 * them — so neither falls through to GET here.
 */
function shouldFallBackToGet(status: number): boolean {
  // HEAD explicitly unsupported — the original, narrower trigger.
  if (status === 405 || status === 501) return true;
  // 2xx/3xx are answers in their own right.
  if (status >= 200 && status < 400) return false;
  // Transient; the retry loop re-attempts these with backoff.
  if (status === 429 || status >= 500) return false;
  // Any other 4xx may be a HEAD-only refusal — verify with a real GET.
  return true;
}

async function probeUrl(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxRetries: number,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<{ httpStatus: number | null; classification: SourceClassification; errorCode?: string; lookupCode?: string }> {
  const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { method, signal: controller.signal, redirect: "manual", headers: BROWSER_HEADERS });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await attempt("HEAD");
    // Some servers reject or misreport HEAD — verify with GET before
    // believing a failure. Never read the body either way.
    if (shouldFallBackToGet(res.status)) {
      res = await attempt("GET");
    }

    let retries = 0;
    while (retries < maxRetries && (res.status === 429 || res.status >= 500)) {
      if (res.status === 429) {
        // Header/object may be absent on mocked responses — guard both.
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after"));
        const waitMs = retryAfterMs !== null && retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : RETRY_BACKOFF_MS[retries] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
        await sleepImpl(waitMs);
      } else {
        // 5xx — short exponential backoff.
        await sleepImpl(RETRY_BACKOFF_MS[retries] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      }
      retries++;
      res = await attempt("HEAD");
      if (shouldFallBackToGet(res.status)) {
        res = await attempt("GET");
      }
    }

    return { httpStatus: res.status, classification: classifyStatus(res.status) };
  } catch (err) {
    // Note: DOMException (thrown by AbortController.abort()) does not
    // reliably satisfy `instanceof Error` across environments (observed
    // false in Vitest/jsdom), so check the `name` property directly rather
    // than gating on instanceof Error first.
    const name = (err as { name?: unknown } | null)?.name;
    if (name === "AbortError") {
      return { httpStatus: null, classification: "timeout" };
    }
    // The pinned connection refused a blocked address (e.g. DNS rebinding):
    // terminal, never retried.
    if (isSsrfBlockedError(err)) {
      return { httpStatus: null, classification: "blocked" };
    }
    // lookupCode is set only when the failure came from the DNS lookup itself,
    // never for a socket-level ECONNREFUSED to the source host.
    return { httpStatus: null, classification: "error", errorCode: redactedErrorCode(err), lookupCode: lookupFailureCode(err) };
  }
}

/**
 * Checks liveness of every source URL across all provided facilities.
 * Bounded concurrency, HEAD-then-GET-fallback, per-request AbortController
 * timeout. Never reads response bodies.
 */
export async function checkSources(facilities: Facility[], deps: SourceCheckDeps): Promise<SourceCheckResult[]> {
  const tasks: SourceTask[] = [];
  for (const facility of facilities) {
    for (const [sourceIndex, source] of facility.sources.entries()) {
      tasks.push({ facilityId: facility.id, facilityName: facility.name, url: source.url, sourceIndex });
    }
  }

  const maxRetries = deps.maxRetries ?? 2;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;

  // Every resolution this run starts (pre-check and connect) passes one rate
  // gate and one vetted-address cache, so a host costs one A+AAAA pair per TTL.
  const resolveDeps: ResolveDeps = {
    ...deps.resolveDeps,
    beforeResolve: createRateGate(deps.lookupsPerSecond ?? LOOKUP_RATE_PER_SECOND, deps.nowImpl),
  };
  const closable = deps.fetchImpl ? undefined : createClosablePinnedFetch(resolveDeps);
  const fetchImpl = deps.fetchImpl ?? (closable as NonNullable<typeof closable>).fetch;

  // Circuit breakers: consecutive resolver failures (or silent timeouts) mean
  // the resolver is down, refusing us or dropping queries, so every later
  // result would be noise and would keep hammering it.
  const threshold = deps.outageThreshold ?? RESOLVER_OUTAGE_THRESHOLD;
  const timeoutLimit = deps.timeoutThreshold ?? TIMEOUT_OUTAGE_THRESHOLD;
  let consecutiveResolverFailures = 0;
  // Distinct hostnames that have timed out in a row: sources cluster by facility, so
  // many timeouts on ONE dead domain must not read as a silent resolver drop.
  const timeoutHosts = new Set<string>();
  let outage: ResolverOutageError | undefined;
  const observe = (outcome: { host: string; httpStatus: number | null; classification: SourceClassification; errorCode?: string; lookupCode?: string }): void => {
    const lookupCode = outcome.lookupCode;
    if (lookupCode !== undefined && RESOLVER_FAILURE_CODES.has(lookupCode)) {
      consecutiveResolverFailures++;
      timeoutHosts.clear();
      if (!outage && consecutiveResolverFailures >= threshold) {
        outage = new ResolverOutageError(lookupCode, consecutiveResolverFailures);
      }
    } else if (outcome.classification === "timeout") {
      // Neutral for the code-based streak: a timeout says nothing about the lookup code.
      timeoutHosts.add(outcome.host);
      if (!outage && timeoutHosts.size >= timeoutLimit) {
        outage = new ResolverOutageError("ABORT_TIMEOUT", timeoutHosts.size, "timeout");
      }
    } else if (outcome.httpStatus !== null || outcome.errorCode !== undefined || outcome.classification === "blocked") {
      // A definite outcome (including `blocked`: DNS answered) resets both streaks.
      consecutiveResolverFailures = 0;
      timeoutHosts.clear();
    }
  };

  // Resolves (or reads the cache) OUTSIDE probeUrl's AbortController, so time
  // spent queued behind the lookup rate gate never counts against a probe's
  // timeout. Raced against timeoutMs and failing open (undefined) on timeout
  // or a throwing gate; the probe then runs under its own timeout. Fail-open is
  // safe because enforcement lives in the pinned connection (createPinnedFetch):
  // its lookup re-vets whatever address the socket uses and fails closed.
  const vet = async (hostname: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), deps.timeoutMs);
    });
    try {
      return await Promise.race([resolveVetted(hostname, resolveDeps).catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  let results: SourceCheckResult[];
  try {
    results = await runWithConcurrency(tasks, deps.concurrency, async (task): Promise<SourceCheckResult> => {
      const checkedAt = new Date().toISOString();

      // Tripped: schedule nothing more. This placeholder is discarded (the run throws).
      if (outage) {
        return { ...task, httpStatus: null, classification: "error", errorCode: "ABORTED", checkedAt };
      }

      if (!isHttpUrl(task.url)) {
        return {
          facilityId: task.facilityId,
          facilityName: task.facilityName,
          url: task.url,
          sourceIndex: task.sourceIndex,
          httpStatus: null,
          classification: "error",
          errorCode: "INVALID_URL",
          checkedAt,
        };
      }

      // SSRF guard: never connect to private/loopback/link-local/reserved
      // addresses or the cloud metadata endpoint. Checked after isHttpUrl so
      // this only runs on URLs that would otherwise be probed.
      // User-submitted sources reach this lane after approval, so a name that
      // merely resolves to a private address (e.g. 127.0.0.1.nip.io) is refused
      // too. A DNS failure resolves to false and falls through to the probe, so
      // ENOTFOUND stays the outage-vs-link-rot signal. The synchronous
      // isBlockedHost check is load-bearing for IP-literal URLs (net.connect
      // skips lookup for literals); for names, rebinding between this check and
      // the connect is closed by the pinned fetch (see net-guard.ts).
      const hostname = new URL(task.url).hostname;
      const vetted = isBlockedHost(hostname) ? undefined : await vet(hostname);
      if (isBlockedHost(hostname) || vetted?.blocked) {
        observe({ host: hostname, httpStatus: null, classification: "blocked" });
        return {
          facilityId: task.facilityId,
          facilityName: task.facilityName,
          url: task.url,
          sourceIndex: task.sourceIndex,
          httpStatus: null,
          classification: "blocked",
          checkedAt,
        };
      }

      // The resolver itself refused or failed: count it and skip the fetch, which
      // would only re-send the same two queries to a resolver that just failed.
      const resolverCode = vetted && vetted.addresses.length === 0 ? lookupFailureCode(vetted.v4Error) : undefined;
      if (resolverCode !== undefined && RESOLVER_FAILURE_CODES.has(resolverCode)) {
        observe({ host: hostname, httpStatus: null, classification: "error", errorCode: resolverCode, lookupCode: resolverCode });
        return {
          facilityId: task.facilityId,
          facilityName: task.facilityName,
          url: task.url,
          sourceIndex: task.sourceIndex,
          httpStatus: null,
          classification: "error",
          errorCode: resolverCode,
          checkedAt,
        };
      }

      const probe = await probeUrl(task.url, fetchImpl, deps.timeoutMs, maxRetries, sleepImpl);
      observe({ ...probe, host: hostname });
      const { httpStatus, classification, errorCode } = probe;
      return {
        facilityId: task.facilityId,
        facilityName: task.facilityName,
        url: task.url,
        sourceIndex: task.sourceIndex,
        httpStatus,
        classification,
        ...(errorCode !== undefined ? { errorCode } : {}),
        checkedAt,
      };
    });
  } finally {
    // Also runs on a breaker trip: the lane's Agent is never left open.
    await closable?.close();
  }
  if (outage) throw outage;
  return results;
}

// --- CLI ---------------------------------------------------------------

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Machine-consumable source-health report envelope written to disk. */
export interface SourceHealthReport {
  generatedAt: string;
  summary: Record<SourceClassification, number> & { total: number };
  results: SourceCheckResult[];
}

function countByClassification(results: SourceCheckResult[]): Record<SourceClassification, number> & { total: number } {
  const counts: Record<SourceClassification, number> & { total: number } = {
    ok: 0,
    redirected: 0,
    gone: 0,
    bot_blocked: 0,
    throttled: 0,
    server_error: 0,
    client_error: 0,
    timeout: 0,
    error: 0,
    blocked: 0,
    total: results.length,
  };
  for (const r of results) counts[r.classification]++;
  return counts;
}

function writeReport(results: SourceCheckResult[]): string {
  const dir = process.env.DISCOVERY_LOG_DIR ?? path.join(process.cwd(), "discovery-logs");
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(dir, `source-health-${timestamp}.json`);
  const report: SourceHealthReport = {
    generatedAt: new Date().toISOString(),
    summary: countByClassification(results),
    results,
  };
  writeFileSync(logPath, JSON.stringify(report, null, 2));
  return logPath;
}

function summarize(results: SourceCheckResult[]): string {
  const counts = countByClassification(results);
  return (
    `checked ${counts.total} sources: ok=${counts.ok} gone=${counts.gone} bot_blocked=${counts.bot_blocked} ` +
    `throttled=${counts.throttled} server_error=${counts.server_error} client_error=${counts.client_error} ` +
    `redirected=${counts.redirected} timeout=${counts.timeout} error=${counts.error} blocked=${counts.blocked}`
  );
}

/**
 * Checks `facilities`, writes the report and returns the process exit code.
 * A resolver outage aborts with NO report (so `loadLatestSourceHealth`, which
 * picks the newest file, never reads a polluted one) and a non-zero code; the
 * reason names the error code only.
 */
export async function runLane(facilities: Facility[], deps: SourceCheckDeps): Promise<number> {
  try {
    const results = await checkSources(facilities, deps);
    const logPath = writeReport(results);
    console.log(`${summarize(results)} -> ${logPath}`);
    return 0;
  } catch (err) {
    if (!(err instanceof ResolverOutageError)) throw err;
    // Error code only (ABORT_TIMEOUT for the timeout breaker), never the message.
    console.error(`check-sources aborted: resolver outage (${redactedErrorCode(err)}); no report written`);
    return 1;
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const concurrency = Number(process.env.CHECK_SOURCES_CONCURRENCY) || DEFAULT_CONCURRENCY;
  const timeoutMs = Number(process.env.CHECK_SOURCES_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const { facilities, source, apiError } = await loadFacilities(baseUrl);
  if (source === "file") {
    console.warn(
      `WARNING: could not read the live facility index from the API (${apiError}); ` +
        `falling back to the committed data/facilities.json snapshot, which may be stale.`
    );
  }
  process.exitCode = await runLane(facilities, { concurrency, timeoutMs });
}

const isMainModule = isEntrypoint(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error(formatFatalError(err));
    process.exit(1);
  });
}
