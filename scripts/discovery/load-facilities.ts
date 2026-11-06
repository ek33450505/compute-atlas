/**
 * Loads the live facility set — read API first, JSON file fallback.
 *
 * This was byte-identical duplicated logic across five discovery scripts
 * (submit-candidates.ts, check-sources.ts, existing-facilities.ts,
 * extract-fields.ts, verify-fields.ts). The duplication existed because none
 * of those scripts may import one another — each is an independent CLI
 * entrypoint, and importing across them would create coupling between
 * otherwise-unrelated tools. This module resolves that without violating the
 * constraint: it is a leaf with no dependency on any other
 * scripts/discovery/*.ts file, so every script can import it without
 * creating a script-to-script edge. Do NOT import another
 * scripts/discovery/*.ts file from here — that would reintroduce exactly the
 * coupling this module exists to avoid.
 *
 * `fetchImpl` is optional and defaults to the global `fetch`, matching the
 * DI pattern in fetch-page-text.ts's `FetchPageTextDeps.fetchImpl` — added
 * solely so load-facilities.test.ts can inject a fake without touching real
 * network or the real data/facilities.json. Every existing call site omits
 * it and gets identical behavior to before this param existed.
 *
 * The return value carries `source`/`apiError` so a caller can tell whether
 * it got a live read or the committed `data/facilities.json` snapshot. Before
 * this, the fallback was silent: a caller destructuring a bare array had no
 * way to know the index it just received could be stale by however long ago
 * that file was last synced. That mattered concretely in
 * submit-candidates.ts, where a stale index makes "target not found"
 * indistinguishable from a genuinely-new facility (see its docblock above
 * `exitCodeForSummary`) — the fix is to make the fallback observable at the
 * source rather than inferring it downstream from a skip-rate.
 *
 * The API read is retried (3 attempts, 2 s then 8 s apart, 60 s timeout each)
 * on thrown errors, unparseable or facility-less 2xx bodies, 5xx and 429; other
 * 4xx fall back immediately. On 2026-10-14 a single transient `fetch failed`
 * made submit-candidates.ts discard a 23-minute run's 39 candidates, and a
 * hung connection would otherwise have hung the nightly run forever.
 *
 * Bulk `GET /api/facilities` is admin-only while bulk access is paused, so the
 * read sends `Authorization: Bearer $API_ADMIN_TOKEN` when that variable is set
 * (run.sh loads .env.local). A 401/403 stays non-retryable and still falls back
 * to the JSON snapshot, but now warns on stderr (never stdout: some callers
 * print data there) because that snapshot lacks the newest records and a
 * silent fallback produces duplicate candidates.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Facility } from "../../lib/schema";

export type FacilitySource = "api" | "file";

export type LoadFacilitiesResult = {
  facilities: Facility[];
  source: FacilitySource;
  /** Present only when source === "file": why the API read was abandoned. */
  apiError?: string;
};

export const MAX_ATTEMPTS = 3;
/** Delays slept between attempts 1->2 and 2->3. */
export const RETRY_DELAYS_MS = [2_000, 8_000] as const;
export const ATTEMPT_TIMEOUT_MS = 60_000;

export type LoadFacilitiesDeps = {
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Attempt =
  | { ok: true; facilities: Facility[] }
  | { ok: false; error: string; retryable: boolean; status?: number; tokenSent?: boolean };

let warnedInsecureBase = false;

/**
 * The admin token is a full-privilege secret, so it is only sent over https or
 * to a loopback host. Anything else (plain http to a remote host, an
 * unparseable URL) goes without it, with a single stderr warning per process.
 * Any https host receives the token, so the base URL must be the operator's own site.
 */
function bearerAllowedFor(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:") return true;
    return protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

async function attemptOnce(url: string, fetchImpl: typeof fetch): Promise<Attempt> {
  try {
    let token = process.env.API_ADMIN_TOKEN;
    if (token && !bearerAllowedFor(url)) {
      if (!warnedInsecureBase) {
        warnedInsecureBase = true;
        console.error(
          "WARNING: API_ADMIN_TOKEN is set but the API base URL is neither https nor localhost; " +
            "sending the request without the token."
        );
      }
      token = undefined;
    }
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `API responded ${res.status} ${res.statusText}`.trim(),
        retryable: res.status >= 500 || res.status === 429,
        status: res.status,
        tokenSent: Boolean(token),
      };
    }
    const body = (await res.json()) as { facilities?: unknown };
    if (!Array.isArray(body?.facilities)) {
      return { ok: false, error: "API body has no facilities array", retryable: true };
    }
    return { ok: true, facilities: body.facilities as Facility[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
}

export async function loadFacilities(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  deps: LoadFacilitiesDeps = {}
): Promise<LoadFacilitiesResult> {
  const sleep = deps.sleep ?? realSleep;
  let apiError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptOnce(`${baseUrl}/api/facilities`, fetchImpl);
    if (result.ok) return { facilities: result.facilities, source: "api" };
    if (!result.retryable) {
      apiError = result.error;
      if (result.status === 401 || result.status === 403) {
        const why = result.tokenSent
          ? "was sent but rejected (invalid)"
          : process.env.API_ADMIN_TOKEN
            ? "withheld: base URL is not https or loopback"
            : "missing";
        console.error(
          `WARNING: facility API refused the read (${result.status}); API_ADMIN_TOKEN ${why}. ` +
            "Falling back to data/facilities.json, which lacks the newest records, so candidates may duplicate existing facilities."
        );
      }
      break;
    }
    apiError = `${attempt} attempts; last: ${result.error}`;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
  }

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  const facilities = JSON.parse(raw) as Facility[];
  return { facilities, source: "file", apiError };
}
