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
  | { ok: false; error: string; retryable: boolean };

async function attemptOnce(url: string, fetchImpl: typeof fetch): Promise<Attempt> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    if (!res.ok) {
      return {
        ok: false,
        error: `API responded ${res.status} ${res.statusText}`.trim(),
        retryable: res.status >= 500 || res.status === 429,
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
