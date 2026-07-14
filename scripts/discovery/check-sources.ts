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
 * The CLI facility-loading fallback (loadExistingFacilities) is duplicated
 * from submit-candidates.ts rather than shared, per task scope.
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, matching scripts/seed.ts and scripts/discovery/submit-candidates.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Facility } from "../../lib/schema";

// --- types -----------------------------------------------------------------

export type SourceClassification = "ok" | "dead" | "redirected" | "error" | "timeout";

export interface SourceCheckResult {
  facilityId: string;
  facilityName: string;
  url: string;
  httpStatus: number | null;
  classification: SourceClassification;
  checkedAt: string;
}

export interface SourceCheckDeps {
  fetchImpl: typeof fetch;
  concurrency: number;
  timeoutMs: number;
}

interface SourceTask {
  facilityId: string;
  facilityName: string;
  url: string;
}

// --- core --------------------------------------------------------------

/** Only http(s) URLs are dispatched — reject any other scheme defensively.
 * Do not assume a schema-layer restriction is live; it may be parked on
 * another branch. */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function classifyStatus(status: number): SourceClassification {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "redirected";
  return "dead";
}

async function probeUrl(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ httpStatus: number | null; classification: SourceClassification }> {
  const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { method, signal: controller.signal, redirect: "manual" });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await attempt("HEAD");
    // Some servers reject HEAD (405/501) or otherwise behave oddly — retry
    // with GET as a fallback. Never read the body either way.
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      res = await attempt("GET");
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

/** Runs `worker` over `items` with at most `concurrency` in flight at once. */
async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

/**
 * Checks liveness of every source URL across all provided facilities.
 * Bounded concurrency, HEAD-then-GET-fallback, per-request AbortController
 * timeout. Never reads response bodies.
 */
export async function checkSources(facilities: Facility[], deps: SourceCheckDeps): Promise<SourceCheckResult[]> {
  const tasks: SourceTask[] = [];
  for (const facility of facilities) {
    for (const source of facility.sources) {
      tasks.push({ facilityId: facility.id, facilityName: facility.name, url: source.url });
    }
  }

  return runWithConcurrency(tasks, deps.concurrency, async (task): Promise<SourceCheckResult> => {
    const checkedAt = new Date().toISOString();

    if (!isHttpUrl(task.url)) {
      return {
        facilityId: task.facilityId,
        facilityName: task.facilityName,
        url: task.url,
        httpStatus: null,
        classification: "error",
        checkedAt,
      };
    }

    const { httpStatus, classification } = await probeUrl(task.url, deps.fetchImpl, deps.timeoutMs);
    return {
      facilityId: task.facilityId,
      facilityName: task.facilityName,
      url: task.url,
      httpStatus,
      classification,
      checkedAt,
    };
  });
}

// --- CLI ---------------------------------------------------------------

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Fetches the live facility set — read API first, JSON file fallback.
 * Duplicated from submit-candidates.ts:288-302 (loadExistingFacilities) by
 * design — this script must not import submit-candidates.ts. */
async function loadExistingFacilities(baseUrl: string): Promise<Facility[]> {
  try {
    const res = await fetch(`${baseUrl}/api/facilities`);
    if (res.ok) {
      const body = (await res.json()) as { facilities: Facility[] };
      return body.facilities;
    }
  } catch {
    // fall through to file fallback
  }

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  return JSON.parse(raw) as Facility[];
}

function writeReport(results: SourceCheckResult[]): string {
  const dir = process.env.DISCOVERY_LOG_DIR ?? path.join(process.cwd(), "discovery-logs");
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(dir, `source-health-${timestamp}.json`);
  writeFileSync(logPath, JSON.stringify(results, null, 2));
  return logPath;
}

function summarize(results: SourceCheckResult[]): string {
  const counts: Record<SourceClassification, number> = {
    ok: 0,
    dead: 0,
    redirected: 0,
    error: 0,
    timeout: 0,
  };
  for (const r of results) counts[r.classification]++;
  return `checked ${results.length} sources: ok=${counts.ok} dead=${counts.dead} redirected=${counts.redirected} timeout=${counts.timeout} error=${counts.error}`;
}

async function main(): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const concurrency = Number(process.env.CHECK_SOURCES_CONCURRENCY) || DEFAULT_CONCURRENCY;
  const timeoutMs = Number(process.env.CHECK_SOURCES_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const facilities = await loadExistingFacilities(baseUrl);
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
