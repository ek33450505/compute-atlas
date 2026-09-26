/**
 * Index-coverage census — a repeatable, stratified snapshot of what Google
 * Search Console's URL Inspection API reports for a deterministic panel of
 * the site's own sitemap URLs, grouped by route family.
 *
 * Why this exists: prior measurement (see `check-googlebot-access.ts` and
 * `docs/` SEO notes) established that Compute Atlas's indexing problem is
 * CRAWL BUDGET — pages sit in "Discovered - currently not indexed" — not
 * content depth. `/sitemap.xml` used to be one flat sitemap, and GSC reports
 * coverage PER SITEMAP, so "which route family is unindexed?" was
 * unanswerable. It is now a sitemap INDEX over nine per-family children at
 * `/sitemaps/<family>.xml`. This script is the census that turns that split
 * into a stored, comparable measurement. A later unit adds baseline/drift on
 * top of this file's output — the output shape here is designed to be diffed
 * run over run, which is why the sampling is deterministic (see below).
 *
 * ## The falsifiable check
 *
 * A PASSING census is: every URL in the sampled panel has a recorded
 * inspection result (`byRoute` has exactly one entry per sampled URL, and
 * `sampled.totalInspected` matches `Object.keys(byRoute).length`). It is NOT
 * "most routes are indexed." A census that runs cleanly while coverage is
 * terrible is a CORRECT census — do not read a green run here as good news
 * about indexing health. That comparison belongs to the baseline/drift unit
 * built on top of this file's output, not to this script.
 *
 * ## Route enumeration: the live sitemap, not `lib/sitemap-routes.ts`
 *
 * This deliberately does NOT import the route builders from
 * `lib/sitemap-routes.ts`: they go through `loadFacilities`, which is
 * `unstable_cache`'d and requires Next's request-scoped cache context —
 * `lib/data.ts` bypasses that only when `process.env.VITEST` is set, and a
 * bare `tsx` CLI faking that env var would be a lie about the environment.
 * Fetching the live sitemap instead is strictly better here anyway: it
 * measures what was actually SUBMITTED, and family attribution comes free
 * because each child sitemap *is* a family (see `collectSitemapUrlsByFamily`
 * in `lib/sitemap-urls.ts`).
 *
 * `--sitemap=<url>` (see `parseCliArgs`) overrides which sitemap INDEX this
 * fetches from — e.g. a local `next start` build of a branch whose sitemap
 * split hasn't merged/deployed yet. It changes only the route LIST; the URL
 * Inspection target is always `SITE_URL` (the real property), so results
 * still describe production. The resolved value is recorded as
 * `sitemapSource` in both the printed plan and the written report, distinct
 * from `sitemapIndexUrl` (the canonical prod identity, unaffected by the
 * override), so an overridden census is never silently indistinguishable
 * from a normal one.
 *
 * ## Quota: the hard constraint
 *
 * The URL Inspection API allows 600 queries/minute and 2000/day PER
 * PROPERTY — a budget already shared with `check:googlebot`'s 6/day canary.
 * The site has ~3,000 URLs, which does not fit in one day, so this samples:
 *
 *  - STRATIFIED BY FAMILY: an unstratified sample of a population ~75%
 *    dominated by one family (facilities) would measure that family and
 *    nothing else. Small families are inspected WHOLE; large families share
 *    the remaining budget by the SQUARE ROOT of their size (not linear size),
 *    so the biggest family still gets more absolute URLs but cannot crowd
 *    out the other eight the way a linear split would. See
 *    `computeFamilyAllocations`.
 *  - DETERMINISTIC AND STABLE ACROSS RUNS: each family's URL list is sorted
 *    and sampled by a stable stride over the sorted list — never
 *    `Math.random`, never time-dependent. The same URLs must be re-inspected
 *    every census, or drift is confounded with sampling noise and "got
 *    worse" becomes unreadable. A fresh random sample each run would make
 *    the later baseline/drift comparison meaningless. See
 *    `selectStratifiedSample`.
 *  - PACED SEQUENTIALLY with a small delay so 600/minute cannot be exceeded.
 *    A 429 (or any non-2xx) is surfaced LOUDLY by `inspectUrl` throwing —
 *    nothing here retries. Retrying a rate limit is how you turn a
 *    documented ceiling into an actual overage.
 *
 * ## Posture: dry run by default, `--run` is the deliberate act
 *
 * Mirrors `db:sync` (dry run default, `--apply` is the act) and
 * `indexnow.ts` (dry run default, `--submit` is the act). The default
 * invocation makes ZERO calls to the URL Inspection API or the OAuth token
 * endpoint — it only fetches the site's own public sitemap (not
 * quota-metered) and prints the plan: families, the per-family allocation,
 * the total URL count, the share of the daily quota, and where the report
 * would be written. `--run` performs the real inspection.
 *
 * ## A census spanning days is not a snapshot
 *
 * Each `byRoute` record carries its OWN `inspectedAt`, not just the
 * run-level `takenAt` — a census assembled from repeated `--family=<id>`
 * passes on different days (the way `--full`'s refusal above recommends
 * covering everything) has no single instant it was "taken at". The report's
 * `span` names the earliest and latest `inspectedAt` across all records so
 * the elapsed window is visible without rescanning `byRoute`, and `main`
 * prints it — including the elapsed duration in plain words — when a real
 * run finishes.
 *
 * ## Token lifetime, and a run that cannot finish
 *
 * Measured 2026-09-26: a 714-URL panel died at 500/714 after exactly 60
 * minutes with a 401 `ACCESS_TOKEN_EXPIRED` — `fetchAccessToken` is called
 * ONCE in `main`, and the token it returns lives ~1 hour (see
 * `buildSignedJwt`'s `exp: now + 3600` in `check-googlebot-access.ts`). Real
 * per-URL latency (~7s, dominated by the URL Inspection API itself, not
 * `REQUEST_DELAY_MS`) means any panel over roughly 500 URLs is guaranteed to
 * outlive one token, so `main` now refreshes proactively via
 * `createTokenProvider` well before the ~1 hour lifetime
 * (`TOKEN_REFRESH_THRESHOLD_MS`), plus retries a residual
 * `ACCESS_TOKEN_EXPIRED` exactly once (`inspectWithRetry`) for clock skew at
 * the edge. Separately: that same run produced ZERO artifact for ~500 spent
 * live inspections, because the report was only ever written after a clean
 * finish. `main` now writes whatever `byRoute` already holds — marked
 * `partial: true` with the failure reason — the moment the inspection loop
 * throws, then rethrows so the process still exits non-zero. A partial
 * report must never be silently usable as a baseline; see the `partial` field
 * on `IndexCensusReport`.
 *
 * ## Reconciling candidates against the sitemap's own parsed total
 *
 * `main` compares the census's own candidate tally (`plan.totalCandidates`)
 * against an independently-computed count of the `<loc>` entries actually
 * parsed from the (possibly `--family`-scoped) child sitemaps
 * (`reconcileSitemapTotals`). A mismatch means the two are deriving routes
 * from different sources and throws loudly, naming both numbers, rather than
 * silently measuring something other than what was submitted. This
 * deliberately never sees `totalInspected` (the selected sample) — that
 * number is ALWAYS smaller than candidates by design (see the sampling note
 * above), and comparing it here would fire on every ordinary sampled run.
 *
 * ## ⚠️ Classify carefully
 *
 * `Discovered - currently not indexed` and `Crawled - currently not
 * indexed` have DIFFERENT causes (crawl budget vs. quality signals) and are
 * counted in separate summary buckets, never merged. `URL is unknown to
 * Google` is a normal, unprocessed state, not an error — it lands in
 * `other`, not `excluded`. None of these states are failures; see
 * `check-googlebot-access.ts`'s `isBlocked()` header comment, which is
 * explicit that conflating "not indexed" with "blocked" is the single
 * easiest thing to get wrong when reading URL Inspection output.
 *
 * Credentials: same resolution and same fail-open posture as
 * `check-googlebot-access.ts` — `GSC_SERVICE_ACCOUNT_JSON`, else
 * `GSC_CREDENTIALS_PATH`, else `~/.config/gsc-mcp/service-account.json`. A
 * missing credential prints a notice and exits 0; it must never look like a
 * failure.
 *
 * Usage:
 *   npm run census                          # dry run — prints the plan, zero API calls
 *   npm run census -- --limit=200           # dry run with a smaller total target
 *   npm run census -- --family=facilities   # dry run restricted to one family
 *   npm run census -- --sitemap=http://localhost:3999/sitemap.xml
 *                                           # dry run reading routes from a different sitemap
 *                                           # index (e.g. a local prod build of an unmerged branch)
 *   npm run census -- --run                 # perform the real inspection, write the report
 *   npm run census -- --full                # refused — see the quota note in parseCliArgs
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { collectSitemapUrlsByFamily, type SitemapFamilyUrls } from "../lib/sitemap-urls";
import {
  fetchAccessToken,
  inspectUrl,
  loadCredentials,
  SITE_URL,
  type IndexStatusResult,
  type InspectionResult,
  type ServiceAccountCredentials,
} from "./check-googlebot-access";

const HOST = "www.compute-atlas.com";
export const SITEMAP_INDEX_URL = `https://${HOST}/sitemap.xml`;

export const OUTPUT_PATH = join(process.cwd(), "data", "index-census.json");

/** URL Inspection API ceilings, per property (shared with check:googlebot's 6/day). */
export const DAILY_QUOTA = 2000;
export const PER_MINUTE_QUOTA = 600;

/**
 * Delay between sequential inspection calls. 600/minute allows one call per
 * 100ms at the ceiling; 150ms leaves real margin (~400/minute) rather than
 * shaving against the limit.
 */
export const REQUEST_DELAY_MS = 150;

/** Default total inspection budget for one run — comfortably under DAILY_QUOTA. */
export const DEFAULT_TOTAL_TARGET = 800;

/** A family at or under this size is inspected WHOLE — already cheap enough that sampling it buys no quota benefit. */
export const WHOLE_FAMILY_CEILING = 60;

/** Floor so a large family sharing the budget with others never rounds down toward zero. */
export const MIN_LARGE_FAMILY_SHARE = 15;

/** Ceiling so no single large family (e.g. facilities, ~75% of all URLs) can consume the whole remaining budget. */
export const MAX_LARGE_FAMILY_SHARE = 300;

/**
 * Proactive access-token refresh threshold. `fetchAccessToken`'s token lives
 * ~1 hour (see `buildSignedJwt`'s `exp: now + 3600` in
 * check-googlebot-access.ts); 45 minutes leaves comfortable margin before
 * expiry for a census that spans far longer than one token's lifetime. See
 * `createTokenProvider` and the module header's "Token lifetime" section.
 */
export const TOKEN_REFRESH_THRESHOLD_MS = 45 * 60 * 1000;

/**
 * Measured 2026-09-26 against this property: 500 inspections completed in 59
 * minutes before the run died on ACCESS_TOKEN_EXPIRED — ~7s/URL end to end,
 * dominated by the URL Inspection API's own latency, not by
 * REQUEST_DELAY_MS. Used only to print an estimate in the dry-run plan; never
 * used for pacing or scheduling.
 */
export const MEASURED_MS_PER_URL = 7_000;

export const SAMPLING_STRATEGY_DESCRIPTION =
  "stratified-by-family: families at or under a whole-family ceiling are inspected in full; " +
  "larger families share the remaining budget by sqrt(size) with a floor and cap per family; " +
  "each family's panel is a deterministic stable-stride sample over its URLs sorted lexicographically";

export interface FamilyAllocation {
  family: string;
  candidates: number;
  allocated: number;
}

export interface RouteInspectionEntry {
  family: string;
  /**
   * When THIS URL's inspection returned — not the run-level `takenAt`. A
   * census assembled from repeated `--family=<id>` passes across days has no
   * single instant; this is what makes the span (below) meaningful. Optional
   * because pure-function callers (e.g. `buildSummary` tests) construct
   * entries without it — it is always set on entries `main` actually writes.
   */
  inspectedAt?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  verdict?: string;
}

export interface FamilySummary {
  inspected: number;
  indexed: number;
  discovered_not_indexed: number;
  crawled_not_indexed: number;
  excluded: number;
  other: number;
}

export interface IndexCensusReport {
  takenAt: string;
  siteUrl: string;
  sitemapIndexUrl: string;
  /** Sitemap actually fetched for this run's route list — equal to `sitemapIndexUrl` unless `--sitemap=<url>` overrode it. */
  sitemapSource: string;
  sampled: {
    strategy: string;
    totalCandidates: number;
    totalInspected: number;
  };
  byRoute: Record<string, RouteInspectionEntry>;
  summary: {
    byFamily: Record<string, FamilySummary>;
  };
  /**
   * Earliest/latest `inspectedAt` across `byRoute`, derived by
   * `computeInspectionSpan`. `undefined` only when `byRoute` has no
   * timestamped records (should not happen on a real run).
   */
  span?: {
    firstInspectedAt: string;
    lastInspectedAt: string;
  };
  /**
   * Set only when the inspection loop threw before covering every planned
   * URL (see `main`'s try/catch around the inspection loop) — a real
   * 401/429/network failure mid-run, NOT a normal completed census. `byRoute`
   * and `summary` above are computed over ONLY the URLs actually inspected
   * before the failure, never the planned total (`sampled.totalInspected`
   * still names the plan, so the shortfall is visible by comparing the two).
   * Consumers that treat a report as a comparable baseline —
   * `census-baseline.ts` and `census-diff.ts` — MUST check this field and
   * refuse a partial report rather than silently baselining/diffing an
   * undercount; that refusal is tracked separately and is deliberately NOT
   * wired here.
   */
  partial?: true;
  /** Why the run stopped early — the caught error's message. Only set when `partial` is true. */
  partialReason?: string;
}

export interface CensusPlan {
  siteUrl: string;
  sitemapIndexUrl: string;
  /** Sitemap actually fetched to build this plan — equal to `sitemapIndexUrl` unless `--sitemap=<url>` overrode it. */
  sitemapSource: string;
  totalTarget: number;
  allocations: FamilyAllocation[];
  totalCandidates: number;
  totalInspected: number;
  selectionsByFamily: Record<string, string[]>;
}

export interface CliOptions {
  /** Perform the real inspection. Default false — see the posture note above. */
  run: boolean;
  /** Override DEFAULT_TOTAL_TARGET. */
  limit?: number;
  /** Restrict the run to a single family id. */
  family?: string;
  /**
   * Override SITEMAP_INDEX_URL — e.g. a local `next start` build serving the
   * real sitemap INDEX for a branch that hasn't merged/deployed yet.
   * Undefined means "use the default"; when set it is already validated as
   * an absolute http(s) URL (see parseCliArgs). Only the route LIST this
   * script reads changes — the URL Inspection target (SITE_URL) does not.
   */
  sitemap?: string;
}

const KNOWN_BARE_FLAGS = new Set(["--run", "--full"]);

/**
 * `--full` is a recognized flag that is always REFUSED, not silently
 * accepted: enumerating all ~3,000 URLs would take multiple days against the
 * 600/min, 2000/day quota, and this script does not implement a multi-day
 * resume cursor. Refusing loudly is safer than either blowing the quota or
 * quietly capping "--full" down to something smaller than the name promises.
 */
export function parseCliArgs(argv: string[]): CliOptions {
  if (argv.includes("--full")) {
    throw new Error(
      "--full is not supported: enumerating every URL would span multiple days against the " +
        `${PER_MINUTE_QUOTA}/min, ${DAILY_QUOTA}/day URL Inspection quota, and this script has no ` +
        "multi-day resume. Use the default stratified panel, or run repeated --family=<id> passes " +
        "deliberately across days."
    );
  }

  const flagsAndUnknown = argv.filter((arg) => arg.startsWith("-"));
  const positionals = argv.filter((arg) => !arg.startsWith("-"));
  const unknownFlags = flagsAndUnknown.filter(
    (arg) =>
      !KNOWN_BARE_FLAGS.has(arg) &&
      !arg.startsWith("--limit=") &&
      !arg.startsWith("--family=") &&
      !arg.startsWith("--sitemap=")
  );
  if (unknownFlags.length > 0 || positionals.length > 0) {
    throw new Error(
      `Unknown argument(s): ${[...unknownFlags, ...positionals].join(", ")}. ` +
        "Known flags: --run, --limit=N, --family=<id>, --sitemap=<url>, --full"
    );
  }

  const limitFlag = flagsAndUnknown.find((arg) => arg.startsWith("--limit="));
  let limit: number | undefined;
  if (limitFlag !== undefined) {
    const raw = limitFlag.slice("--limit=".length);
    limit = Number(raw);
    // An unparseable limit must not silently become "no limit" — the exact
    // shape of the run.sh ENRICHMENT_LIMIT trap this repo has already hit.
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`--limit must be a positive integer, got: ${raw || "(empty)"}`);
    }
  }

  const familyFlag = flagsAndUnknown.find((arg) => arg.startsWith("--family="));
  const family = familyFlag !== undefined ? familyFlag.slice("--family=".length) : undefined;
  if (familyFlag !== undefined && !family) {
    throw new Error("--family requires a value, e.g. --family=facilities");
  }

  const sitemapFlag = flagsAndUnknown.find((arg) => arg.startsWith("--sitemap="));
  let sitemap: string | undefined;
  if (sitemapFlag !== undefined) {
    const raw = sitemapFlag.slice("--sitemap=".length);
    if (!raw) {
      throw new Error(
        "--sitemap requires a value, e.g. --sitemap=http://localhost:3999/sitemap.xml"
      );
    }
    // A malformed value must not silently fall through to a fetch — validate
    // eagerly with new URL(), and require http(s) specifically (rules out
    // e.g. file:// while still allowing a bare http:// + port for local use).
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("not http(s)");
      }
    } catch {
      throw new Error(
        "--sitemap must be an absolute http(s) URL (e.g. https://host/sitemap.xml or " +
          `http://localhost:3999/sitemap.xml), got: ${raw}`
      );
    }
    sitemap = raw;
  }

  return { run: argv.includes("--run"), limit, family, sitemap };
}

/**
 * Deterministic stratified pick of `count` URLs out of `urls`.
 *
 * Sorting first is what makes this stable regardless of the order the
 * sitemap happened to list URLs in on a given fetch (including a shuffled
 * input — see the test file). Walking the sorted list at an even stride
 * (rather than just taking the first `count`) spreads the sample across the
 * family instead of clustering at whatever sorts first alphabetically.
 *
 * No randomness, no time-dependence: the same `urls` set always yields the
 * same selected URLs, which is the property the later baseline/drift
 * comparison depends on.
 */
export function selectStratifiedSample(urls: string[], count: number): string[] {
  if (count <= 0 || urls.length === 0) return [];
  const sorted = [...urls].sort();
  if (count >= sorted.length) return sorted;

  const stride = sorted.length / count;
  const seenIndexes = new Set<number>();
  const selected: string[] = [];
  for (let i = 0; i < count; i++) {
    let idx = Math.floor(i * stride);
    while (seenIndexes.has(idx) && idx < sorted.length - 1) idx += 1;
    seenIndexes.add(idx);
    selected.push(sorted[idx]);
  }
  return selected;
}

/**
 * Splits `totalTarget` across families in two tiers:
 *
 *  1. Any family at or under WHOLE_FAMILY_CEILING is allocated in full.
 *  2. Every larger family shares whatever budget remains, weighted by the
 *     SQUARE ROOT of its size rather than its raw size. Facilities is ~75%
 *     of the site's URLs; a linear split would spend ~75% of every census on
 *     one family and starve the other eight of any real sample. Square-root
 *     weighting still gives bigger families more absolute URLs (more pages
 *     to check) but compresses the gap — the same motivation as Neyman
 *     allocation in stratified sampling.
 *
 * `effectiveFloor` guarantees every large family gets at least 1 URL (never
 * drops to zero while others are sampled) without letting that floor itself
 * blow past a caller's explicit small `totalTarget` — it shrinks to
 * `remaining / large.length` when the remaining budget is itself tight
 * (e.g. an explicit small --limit against a single --family), rather than
 * always enforcing MIN_LARGE_FAMILY_SHARE regardless of what was asked for.
 * `MAX_LARGE_FAMILY_SHARE` and each family's own size both still cap it from
 * above.
 */
export function computeFamilyAllocations(
  families: SitemapFamilyUrls[],
  totalTarget: number = DEFAULT_TOTAL_TARGET
): FamilyAllocation[] {
  const whole: FamilyAllocation[] = [];
  const large: SitemapFamilyUrls[] = [];

  for (const f of families) {
    if (f.urls.length === 0) continue;
    if (f.urls.length <= WHOLE_FAMILY_CEILING) {
      whole.push({ family: f.family, candidates: f.urls.length, allocated: f.urls.length });
    } else {
      large.push(f);
    }
  }

  if (large.length === 0) return whole;

  const wholeTotal = whole.reduce((sum, f) => sum + f.allocated, 0);
  const remaining = Math.max(0, totalTarget - wholeTotal);
  const effectiveFloor = Math.max(
    1,
    Math.min(MIN_LARGE_FAMILY_SHARE, Math.floor(remaining / large.length))
  );

  const weights = large.map((f) => Math.sqrt(f.urls.length));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const largeAllocations: FamilyAllocation[] = large.map((f, i) => {
    const proportional = weightSum > 0 ? Math.round((weights[i] / weightSum) * remaining) : 0;
    const allocated = Math.min(
      f.urls.length,
      MAX_LARGE_FAMILY_SHARE,
      Math.max(effectiveFloor, proportional)
    );
    return { family: f.family, candidates: f.urls.length, allocated };
  });

  return [...whole, ...largeAllocations];
}

export function buildCensusPlan(
  families: SitemapFamilyUrls[],
  totalTarget: number = DEFAULT_TOTAL_TARGET,
  sitemapSource: string = SITEMAP_INDEX_URL
): CensusPlan {
  const allocations = computeFamilyAllocations(families, totalTarget);
  const urlsByFamily = new Map(families.map((f) => [f.family, f.urls]));

  const selectionsByFamily: Record<string, string[]> = {};
  for (const alloc of allocations) {
    selectionsByFamily[alloc.family] = selectStratifiedSample(
      urlsByFamily.get(alloc.family) ?? [],
      alloc.allocated
    );
  }

  return {
    siteUrl: SITE_URL,
    sitemapIndexUrl: SITEMAP_INDEX_URL,
    sitemapSource,
    totalTarget,
    allocations,
    totalCandidates: families.reduce((sum, f) => sum + f.urls.length, 0),
    totalInspected: allocations.reduce((sum, a) => sum + a.allocated, 0),
    selectionsByFamily,
  };
}

/**
 * Pure classification of a GSC `coverageState` string into a summary bucket.
 * Order matters: "Discovered - currently not indexed" and "Crawled -
 * currently not indexed" both CONTAIN the substring "indexed", so the two
 * not-indexed checks must run before the generic indexed check or every
 * crawl-budget state would be miscounted as indexed.
 */
export function classifyCoverageState(
  coverageState: string | undefined
): keyof Omit<FamilySummary, "inspected"> {
  const s = (coverageState ?? "").toLowerCase().trim();
  if (!s || s.includes("unknown to google")) return "other";
  if (s.includes("discovered") && s.includes("not indexed")) return "discovered_not_indexed";
  if (s.includes("crawled") && s.includes("not indexed")) return "crawled_not_indexed";
  if (s.includes("indexed")) return "indexed";
  // Everything else: blocked by robots.txt, excluded by noindex, duplicate
  // (with or without user-selected canonical), alternate page with proper
  // canonical, page with redirect, not found (404), soft 404, server error.
  return "excluded";
}

export function buildSummary(byRoute: Record<string, RouteInspectionEntry>): IndexCensusReport["summary"] {
  const byFamily: Record<string, FamilySummary> = {};
  for (const entry of Object.values(byRoute)) {
    const summary = (byFamily[entry.family] ??= {
      inspected: 0,
      indexed: 0,
      discovered_not_indexed: 0,
      crawled_not_indexed: 0,
      excluded: 0,
      other: 0,
    });
    summary.inspected += 1;
    summary[classifyCoverageState(entry.coverageState)] += 1;
  }
  return { byFamily };
}

/**
 * Earliest and latest `inspectedAt` across every `byRoute` record — computed
 * once here so a later reader (e.g. the baseline/drift unit) doesn't need to
 * rescan `byRoute` itself to learn the elapsed window. `undefined` only when
 * `byRoute` has no timestamped records at all (should not happen on a real
 * run — see `main` — but this stays a pure function, so it does not assume
 * that).
 */
export function computeInspectionSpan(
  byRoute: Record<string, RouteInspectionEntry>
): { firstInspectedAt: string; lastInspectedAt: string } | undefined {
  const timestamps = Object.values(byRoute)
    .map((entry) => entry.inspectedAt)
    .filter((t): t is string => Boolean(t))
    .sort();
  if (timestamps.length === 0) return undefined;
  return { firstInspectedAt: timestamps[0], lastInspectedAt: timestamps[timestamps.length - 1] };
}

/**
 * Formats a millisecond duration as a short, human-readable two-unit string
 * — e.g. "11m 42s", "2h 5m", "2d 3h" — so `main` can say a census's elapsed
 * span "in plain words" (see the module header). Always shows the two
 * highest-precision non-empty units for the span's scale; never negative.
 */
export function formatDurationWords(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Estimated wall-clock duration for inspecting `totalInspected` URLs, using
 * `MEASURED_MS_PER_URL` (measured 2026-09-26 against this property — API
 * latency, not `REQUEST_DELAY_MS`, is the binding constraint; see the module
 * header). Printed in the dry-run plan so a maintainer can see e.g. "714 URLs
 * ~ 83m" BEFORE starting, rather than discovering it an hour later.
 */
export function estimateDurationMs(totalInspected: number): number {
  return totalInspected * MEASURED_MS_PER_URL;
}

/**
 * Guards that the census's own candidate tally and the number of `<loc>`
 * entries actually parsed from the child sitemaps have not diverged — see
 * the module header's "Reconciling candidates" section. Deliberately takes
 * ONLY these two numbers — never `totalInspected`/selected, which is ALWAYS
 * <= candidates by design (the stratified sample, see `selectStratifiedSample`
 * above). Passing selected here instead of the parsed total would make this
 * fire on every ordinary sampled run.
 */
export function reconcileSitemapTotals(candidateTotal: number, parsedTotal: number): void {
  if (candidateTotal !== parsedTotal) {
    throw new Error(
      `Sitemap reconciliation failed: the census counted ${candidateTotal} candidate URL(s) across ` +
        `families, but ${parsedTotal} <loc> entries were actually parsed from the child sitemaps. ` +
        "The census and the sitemap are deriving routes from different sources — they must share one source."
    );
  }
}

function printPlan(plan: CensusPlan, totalParsedSitemapUrls: number): void {
  console.log(`Index census plan — ${plan.siteUrl}`);
  console.log(`Sitemap index: ${plan.sitemapIndexUrl}`);
  console.log(`Sitemap source: ${plan.sitemapSource}`);
  console.log(`Target total: ${plan.totalTarget} (daily quota: ${DAILY_QUOTA})\n`);
  console.log("family".padEnd(16) + "candidates".padStart(12) + "allocated".padStart(12));
  for (const a of plan.allocations) {
    console.log(a.family.padEnd(16) + String(a.candidates).padStart(12) + String(a.allocated).padStart(12));
  }
  const quotaShare = ((plan.totalInspected / DAILY_QUOTA) * 100).toFixed(1);
  const estimatedDuration = formatDurationWords(estimateDurationMs(plan.totalInspected));
  console.log(
    `\nTotal sitemap URLs parsed from the child sitemaps: ${totalParsedSitemapUrls}` +
      `\nTotal candidates across the sitemap: ${plan.totalCandidates}` +
      `\nTotal to inspect this run (selected for inspection): ${plan.totalInspected} ` +
      `(${quotaShare}% of the ${DAILY_QUOTA}/day quota)` +
      `\nEstimated duration: ~${estimatedDuration} ` +
      `(measured ~${(MEASURED_MS_PER_URL / 1000).toFixed(0)}s/URL against this property, 2026-09-26 — ` +
      "dominated by URL Inspection API latency, not REQUEST_DELAY_MS)" +
      `\nOutput would be written to: ${OUTPUT_PATH}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Detects the ACCESS_TOKEN_EXPIRED shape `inspectUrl` throws once a token
 * outlives the ~1 hour lifetime `buildSignedJwt` (check-googlebot-access.ts)
 * signs into it — measured 2026-09-26, a 714-URL panel died on exactly this
 * at 500/714. `inspectUrl` throws a plain Error whose message embeds the raw
 * HTTP status and response body (`URL Inspection failed for <url>: 401
 * <body>`), so detection is a substring check on both markers. This must stay
 * narrow: any OTHER error (e.g. a 429 rate limit) is a real failure and must
 * keep surfacing immediately, unretried — see `inspectWithRetry`.
 */
export function isAccessTokenExpiredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("401") && message.includes("ACCESS_TOKEN_EXPIRED");
}

export interface TokenProvider {
  /** Returns a valid token, transparently refreshing when the cached one has aged past the threshold. */
  getToken(): Promise<string>;
  /** Unconditionally mints a fresh token and resets the age clock — the reactive retry-once-on-401 path (`inspectWithRetry`) uses this directly, bypassing the age check. */
  refresh(): Promise<string>;
}

/**
 * Wraps `fetchAccessToken` with a proactive refresh so a census far longer
 * than one token's ~1 hour lifetime survives it — see the module header's
 * "Token lifetime" section and `TOKEN_REFRESH_THRESHOLD_MS`. `nowMs` is
 * injectable (tests use a fake sequence; real runs default to `Date.now`) so
 * the threshold crossing is testable without waiting on a real clock.
 */
export function createTokenProvider(
  creds: ServiceAccountCredentials,
  deps: {
    fetchAccessToken: typeof fetchAccessToken;
    nowMs?: () => number;
    refreshThresholdMs?: number;
  }
): TokenProvider {
  const nowMs = deps.nowMs ?? Date.now;
  const refreshThresholdMs = deps.refreshThresholdMs ?? TOKEN_REFRESH_THRESHOLD_MS;
  let token: string | undefined;
  let mintedAtMs = 0;

  async function refresh(): Promise<string> {
    token = await deps.fetchAccessToken(creds);
    mintedAtMs = nowMs();
    return token;
  }

  async function getToken(): Promise<string> {
    if (token === undefined || nowMs() - mintedAtMs >= refreshThresholdMs) {
      return refresh();
    }
    return token;
  }

  return { getToken, refresh };
}

/**
 * Inspects one URL, with exactly one refresh-and-retry when the proactive
 * threshold in `createTokenProvider` still missed an expiry (clock skew, or a
 * token that expired mid-request). A SECOND consecutive
 * ACCESS_TOKEN_EXPIRED on the same URL is a real failure, not more skew, and
 * propagates rather than retrying again. Any other error (e.g. a 429
 * rate limit) is never retried and propagates immediately, unchanged from
 * before this fix.
 */
async function inspectWithRetry(tokenProvider: TokenProvider, url: string): Promise<InspectionResult> {
  const token = await tokenProvider.getToken();
  try {
    return await inspectUrl(token, url);
  } catch (err) {
    if (!isAccessTokenExpiredError(err)) throw err;
    const freshToken = await tokenProvider.refresh();
    return await inspectUrl(freshToken, url);
  }
}

export async function main(
  argv: string[],
  deps: { now?: () => string; nowMs?: () => number } = {}
): Promise<void> {
  const now = deps.now ?? defaultNow;
  const options = parseCliArgs(argv);
  const sitemapSource = options.sitemap ?? SITEMAP_INDEX_URL;

  let families = await collectSitemapUrlsByFamily(sitemapSource);
  if (options.family) {
    const matched = families.filter((f) => f.family === options.family);
    if (matched.length === 0) {
      throw new Error(
        `Unknown family "${options.family}". Known families: ${families.map((f) => f.family).join(", ")}`
      );
    }
    families = matched;
  }

  // The number of <loc> entries actually parsed from the (possibly
  // --family-scoped) child sitemaps — computed here, independently of
  // buildCensusPlan's own totalCandidates bookkeeping, so the two can be
  // reconciled below. See reconcileSitemapTotals and the module header.
  const totalParsedSitemapUrls = families.reduce((sum, f) => sum + f.urls.length, 0);

  const plan = buildCensusPlan(families, options.limit ?? DEFAULT_TOTAL_TARGET, sitemapSource);
  reconcileSitemapTotals(plan.totalCandidates, totalParsedSitemapUrls);
  printPlan(plan, totalParsedSitemapUrls);

  if (!options.run) {
    console.log("\nDRY RUN — no Search Console API calls were made. Re-run with --run to inspect.");
    return;
  }

  const creds = loadCredentials();
  if (!creds) {
    console.log(
      "::notice::No GSC service-account credential found (checked GSC_SERVICE_ACCOUNT_JSON and " +
        "GSC_CREDENTIALS_PATH / the gsc-mcp default) — skipping the index census."
    );
    process.exit(0);
  }

  const tokenProvider = createTokenProvider(creds, { fetchAccessToken, nowMs: deps.nowMs });

  const byRoute: Record<string, RouteInspectionEntry> = {};
  let done = 0;
  let loopError: unknown;
  try {
    for (const [family, urls] of Object.entries(plan.selectionsByFamily)) {
      for (const url of urls) {
        // Sequential, never parallel — see REQUEST_DELAY_MS / the quota note
        // in the file header. A 429 or any other non-2xx throws out of
        // inspectUrl and stops this loop rather than being retried — except
        // an ACCESS_TOKEN_EXPIRED 401, which inspectWithRetry refreshes and
        // retries exactly once (see its own header comment).
        const result: InspectionResult = await inspectWithRetry(tokenProvider, url);
        const status: IndexStatusResult = result.indexStatusResult;
        byRoute[url] = {
          family,
          inspectedAt: now(),
          coverageState: status.coverageState,
          robotsTxtState: status.robotsTxtState,
          indexingState: status.indexingState,
          lastCrawlTime: status.lastCrawlTime,
          pageFetchState: status.pageFetchState,
          verdict: status.verdict,
        };
        done += 1;
        if (done % 50 === 0) console.log(`  ...${done}/${plan.totalInspected} inspected`);
        await sleep(REQUEST_DELAY_MS);
      }
    }
  } catch (err) {
    // A run that dies partway must still leave a salvageable artifact — ~500
    // live inspections were spent and produced NOTHING on 2026-09-26 because
    // the report was only ever written after a clean finish (see the module
    // header's "Token lifetime" section). Record the failure and fall
    // through to the normal write path below with whatever byRoute already
    // holds; rethrow once the partial report is safely on disk.
    loopError = err;
  }

  const span = computeInspectionSpan(byRoute);
  const report: IndexCensusReport = {
    takenAt: now(),
    siteUrl: plan.siteUrl,
    sitemapIndexUrl: plan.sitemapIndexUrl,
    sitemapSource: plan.sitemapSource,
    sampled: {
      strategy: SAMPLING_STRATEGY_DESCRIPTION,
      totalCandidates: plan.totalCandidates,
      totalInspected: plan.totalInspected,
    },
    byRoute,
    summary: buildSummary(byRoute),
    span,
    ...(loopError !== undefined
      ? {
          partial: true as const,
          partialReason: loopError instanceof Error ? loopError.message : String(loopError),
        }
      : {}),
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n");

  if (loopError !== undefined) {
    console.error(
      `\n::error::Census PARTIAL — inspected ${Object.keys(byRoute).length}/${plan.totalInspected} ` +
        `planned URL(s) before the run failed. Wrote a partial report (partial: true) to ${OUTPUT_PATH}. ` +
        `Reason: ${report.partialReason}`
    );
  } else {
    console.log(`\nWrote ${Object.keys(byRoute).length} inspection(s) to ${OUTPUT_PATH}`);
  }
  if (span) {
    const elapsedMs = Math.max(0, Date.parse(span.lastInspectedAt) - Date.parse(span.firstInspectedAt));
    console.log(
      `Inspection span: ${span.firstInspectedAt} -> ${span.lastInspectedAt} ` +
        `(inspected over ${formatDurationWords(elapsedMs)})`
    );
  }

  if (loopError !== undefined) {
    throw loopError;
  }
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches scripts/indexnow.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
