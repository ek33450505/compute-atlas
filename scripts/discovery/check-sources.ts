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

export type SourceClassification = "ok" | "dead" | "redirected" | "error" | "timeout" | "blocked";

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

// --- SSRF guard --------------------------------------------------------

/** Converts a dotted-quad IPv4 string to its uint32 representation, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    // Octets are parsed base-10, including leading zeros (e.g. "08" -> 8,
    // NOT treated as octal) — that leniency is intentional and safe here:
    // (i) the WHATWG URL parser canonicalizes hostnames before they reach
    // this function, so leading-zero octets don't occur on the real code
    // path, and (ii) even if one did, a leading-zero decimal octet still
    // maps to the correct, still-blocked address (e.g. "127.000.000.001"
    // parses to 127.0.0.1). Tightening this to reject leading zeros would
    // make such addresses fall through UNblocked instead.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

/** True if `ip` (uint32) falls within the CIDR block `base/prefixLength`. */
function ipv4InCidr(ip: number, base: string, prefixLength: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

/**
 * Private/loopback/link-local/reserved IPv4 ranges that must never be
 * probed, including the cloud metadata IP (169.254.169.254, covered by the
 * 169.254.0.0/16 link-local block).
 */
const BLOCKED_IPV4_CIDRS: Array<{ base: string; prefixLength: number }> = [
  { base: "0.0.0.0", prefixLength: 8 },
  { base: "10.0.0.0", prefixLength: 8 },
  { base: "100.64.0.0", prefixLength: 10 },
  { base: "127.0.0.0", prefixLength: 8 },
  { base: "169.254.0.0", prefixLength: 16 },
  { base: "172.16.0.0", prefixLength: 12 },
  { base: "192.0.0.0", prefixLength: 24 },
  { base: "192.168.0.0", prefixLength: 16 },
  { base: "198.18.0.0", prefixLength: 15 },
  { base: "224.0.0.0", prefixLength: 4 },
  { base: "240.0.0.0", prefixLength: 4 },
];

function isBlockedIpv4(ip: string): boolean {
  const asInt = ipv4ToInt(ip);
  if (asInt === null) return false;
  return BLOCKED_IPV4_CIDRS.some(({ base, prefixLength }) => ipv4InCidr(asInt, base, prefixLength));
}

/**
 * True for IPv6 loopback (::1), unspecified (::), ULA (fc00::/7),
 * link-local (fe80::/10), and IPv4-mapped addresses (::ffff:a.b.c.d or
 * ::ffff:h1:h2) whose embedded v4 address is itself blocked.
 */
function isBlockedIpv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "::1" || lower === "::") return true;

  // IPv4-mapped IPv6, dotted-quad form (::ffff:a.b.c.d) — extract the
  // embedded v4 and check that. Kept for any hostname passed directly
  // (not routed through new URL()'s canonicalization).
  const mappedDottedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDottedMatch) {
    return isBlockedIpv4(mappedDottedMatch[1]);
  }

  // IPv4-mapped IPv6, canonical hex-hextet form (::ffff:h1:h2) — this is
  // what Node's WHATWG URL parser actually produces, e.g.
  // new URL("http://[::ffff:169.254.169.254]/").hostname === "[::ffff:a9fe:a9fe]".
  // Reconstruct the four v4 octets from the two 16-bit hextets and reuse the
  // existing IPv4 block check.
  const mappedHexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHexMatch) {
    const h1 = parseInt(mappedHexMatch[1], 16);
    const h2 = parseInt(mappedHexMatch[2], 16);
    const octets = [(h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff];
    return isBlockedIpv4(octets.join("."));
  }

  // fc00::/7 (ULA): first hextet's high 7 bits are 1111110 -> first hex
  // nibble is 0xC-0xF is too broad; the precise test is first byte 0xFC/0xFD,
  // i.e. first hextet matches fc00-fdff.
  const firstHextetMatch = lower.match(/^([0-9a-f]{1,4})::?/) ?? lower.match(/^([0-9a-f]{1,4}):/);
  if (firstHextetMatch) {
    const firstHextet = parseInt(firstHextetMatch[1], 16);
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
    // fe80::/10: first 10 bits are 1111111010 -> first hextet in fe80-febf.
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
  }

  return false;
}

/**
 * Returns true when `hostname` must NOT be probed: private/loopback/
 * link-local/reserved IPv4 or IPv6 literals (including the cloud metadata
 * IP 169.254.169.254), `localhost`, or any `*.localhost`.
 *
 * DNS resolution of ordinary hostnames to catch a public name that resolves
 * to a private IP is intentionally OUT of scope — these source URLs are
 * curated, not user-submitted. A follow-up could pin DNS if that changes.
 */
export function isBlockedHost(hostname: string): boolean {
  // `new URL(...).hostname` on a bracketed IPv6 literal (e.g. "[::1]")
  // already strips the brackets, but guard defensively in case a raw
  // bracketed value is passed directly.
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const lower = unbracketed.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (isBlockedIpv4(lower)) return true;
  if (lower.includes(":") && isBlockedIpv6(lower)) return true;

  return false;
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

    // SSRF guard: never connect to private/loopback/link-local/reserved
    // addresses or the cloud metadata endpoint. Checked after isHttpUrl so
    // this only runs on URLs that would otherwise be probed.
    if (isBlockedHost(new URL(task.url).hostname)) {
      return {
        facilityId: task.facilityId,
        facilityName: task.facilityName,
        url: task.url,
        httpStatus: null,
        classification: "blocked",
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
    blocked: 0,
  };
  for (const r of results) counts[r.classification]++;
  return `checked ${results.length} sources: ok=${counts.ok} dead=${counts.dead} redirected=${counts.redirected} timeout=${counts.timeout} error=${counts.error} blocked=${counts.blocked}`;
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
