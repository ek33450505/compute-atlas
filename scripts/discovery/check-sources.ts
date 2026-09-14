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
  isBlockedHost,
  isHttpUrl,
  parseRetryAfterMs,
  runWithConcurrency,
} from "./net-guard";
import { loadFacilities } from "./load-facilities";
import type { Facility } from "../../lib/schema";

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
  checkedAt: string;
}

export interface SourceCheckDeps {
  fetchImpl: typeof fetch;
  concurrency: number;
  timeoutMs: number;
  /** Max retry attempts for 429/5xx responses. Defaults to 2. */
  maxRetries?: number;
  /** Injectable sleep for retry backoff. Defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
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
): Promise<{ httpStatus: number | null; classification: SourceClassification }> {
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
    return { httpStatus: null, classification: "error" };
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

  return runWithConcurrency(tasks, deps.concurrency, async (task): Promise<SourceCheckResult> => {
    const checkedAt = new Date().toISOString();

    if (!isHttpUrl(task.url)) {
      return {
        facilityId: task.facilityId,
        facilityName: task.facilityName,
        url: task.url,
        sourceIndex: task.sourceIndex,
        httpStatus: null,
        classification: "error",
        checkedAt,
      };
    }

    // SSRF guard: never connect to private/loopback/link-local/reserved
    // addresses or the cloud metadata endpoint. Checked after isHttpUrl so
    // this only runs on URLs that would otherwise be probed.
    if (isBlockedHost(new URL(task.url).hostname)) {
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

    const { httpStatus, classification } = await probeUrl(task.url, deps.fetchImpl, deps.timeoutMs, maxRetries, sleepImpl);
    return {
      facilityId: task.facilityId,
      facilityName: task.facilityName,
      url: task.url,
      sourceIndex: task.sourceIndex,
      httpStatus,
      classification,
      checkedAt,
    };
  });
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

async function main(): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const concurrency = Number(process.env.CHECK_SOURCES_CONCURRENCY) || DEFAULT_CONCURRENCY;
  const timeoutMs = Number(process.env.CHECK_SOURCES_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const facilities = await loadFacilities(baseUrl);
  const results = await checkSources(facilities, { fetchImpl: fetch, concurrency, timeoutMs });
  const logPath = writeReport(results);
  console.log(`${summarize(results)} -> ${logPath}`);
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
