import type { z } from "zod";
import { gzipSync, gunzipSync } from "node:zlib";
import { cache as reactCache } from "react";
import { unstable_cache } from "next/cache";
import {
  facilitiesSchema,
  type Facility,
  type CryptoMiningFacility,
  type PowerGenerationFacility,
  aiClassificationEnum,
  confidenceEnum,
} from "@/lib/schema";
import { STATUS_ORDER, type Status } from "@/lib/status";
import { FACILITY_TYPE_ORDER, type FacilityType } from "@/lib/facility-type";
import { COMMUNITY_RECEPTION_ORDER, type CommunityReception } from "@/lib/community";
import { getFacilityMaxMw } from "@/lib/format";
import { getMetroBySlug, metroCountyKey } from "@/lib/metros";
import facilitiesRaw from "@/data/facilities.json";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/lib/db/client";
import { facilitiesTable, facilityHistoryTable, submissionsTable } from "@/lib/db/schema";
import { rowToFacility } from "@/lib/db/serialize";
import type { DiffEntry } from "@/lib/doc-diff";

/**
 * Validated view of the bundled JSON fallback, memoized for the process
 * lifetime. `data/facilities.json` is a static build-time import — immutable
 * while the process runs — so it is validated exactly once and reused. Only
 * the JSON-fallback path (no DATABASE_URL, incl. the VITEST suite) hits this;
 * the DB path never calls it. Mutation-safe: callers only read (`.find`) or
 * spread/filter before sorting, never sort this array in place.
 */
let jsonFallbackCache: Facility[] | undefined;
function loadFromJson(): Facility[] {
  if (jsonFallbackCache) return jsonFallbackCache;
  const parsed = facilitiesSchema.safeParse(facilitiesRaw);
  if (!parsed.success) {
    throw new Error(
      "Invalid facilities data:\n" +
        parsed.error.issues
          .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
          .join("\n")
    );
  }
  jsonFallbackCache = parsed.data;
  return jsonFallbackCache;
}

/**
 * Wraps a Neon-reading async function with a small retry-with-backoff, then
 * falls back to the bundled JSON snapshot on final failure — instead of
 * throwing. Neon's serverless-HTTP driver intermittently throws `fetch
 * failed` under build-time prerender concurrency (hundreds of pages
 * prerendering at once each issuing a DB read) even though the database is
 * otherwise healthy; a short retry absorbs most of that transient burst, and
 * the JSON fallback (already schema-validated, see `loadFromJson`) covers the
 * rest so a Neon blip degrades a page's freshness instead of killing the
 * build. Every fallback is logged (never silent) so a real Neon outage is
 * still visible in build/runtime logs. Exported for direct unit testing
 * (`lib/data.test.ts`) — the retry/fallback logic is intentionally a pure
 * function of `fn`/`fallback` so a test can force a throw without needing to
 * mock the module-scoped `getDb()` singleton.
 */
export async function withJsonFallback<T>(
  fn: () => Promise<T>,
  fallback: () => T,
  maxAttempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 150));
      }
    }
  }
  console.warn(
    "[data] Neon read failed, falling back to bundled JSON snapshot:",
    lastErr
  );
  return fallback();
}

/**
 * Resilient full-table Neon read (retry + JSON fallback via
 * `withJsonFallback`), shared by every reader below that needs the whole
 * facility set from the DB branch (`loadFacilitiesUncached`,
 * `fetchFacilitiesByStateUncached`, `loadPowerGenerationUncached`). Callers
 * still gate on `hasDatabaseUrl()` themselves and call `loadFromJson()`
 * directly (no retry) when it's false — this only wraps the DB branch.
 */
async function selectAllFacilitiesResilient(): Promise<Facility[]> {
  return withJsonFallback(
    async () => (await getDb().select().from(facilitiesTable)).map(rowToFacility),
    loadFromJson
  );
}

/**
 * Loads the full facility set from Neon when `DATABASE_URL` is configured,
 * falling back to the bundled JSON otherwise. DB-sourced docs are trusted
 * as-is (validated at write time via `docToRow`/the Facility schema) — no
 * re-parse on read. Both paths sort by `id` so the DB and fallback produce
 * byte-identical ordering. The DB branch retries transient Neon read
 * failures before degrading to the JSON snapshot (see `withJsonFallback`).
 */
async function loadFacilitiesUncached(): Promise<Facility[]> {
  const list = hasDatabaseUrl() ? await selectAllFacilitiesResilient() : loadFromJson();
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * `unstable_cache` refuses to store entries over 2MB. The full facility array
 * now serializes to ~1.9MB of plain JSON, which pushes past that ceiling once
 * wrapped in `unstable_cache`'s own storage envelope (~2.05MB) — it throws
 * `Failed to set Next.js data cache ... items over 2MB can not be cached` as
 * an unhandledRejection and silently disables caching for the entry. Since
 * `loadFacilitiesForSearch` runs in the root layout on every route, that
 * error fired page-to-page.
 *
 * Fix: cache a gzipped base64 blob (~400KB, years of headroom) instead of the
 * raw array, and inflate on read. `reactCache` memoizes the inflate per
 * request, so a page calling the loader multiple times only decompresses
 * once. `loadFacilitiesUncached` already sorts deterministically and has
 * `withJsonFallback`, so gzip output stays deterministic and the cache
 * remains outage-resilient (serves the last good compressed blob if Neon is
 * down). Shared by both `loadFacilities` and `loadFacilitiesForSearch` below
 * so the compression logic lives in exactly one place.
 */
function loadFacilitiesCompressed(
  keyParts: string[],
  opts: { tags?: string[]; revalidate: number }
): () => Promise<Facility[]> {
  const loadCompressedBlob = unstable_cache(
    async () => {
      const json = JSON.stringify(await loadFacilitiesUncached());
      return gzipSync(Buffer.from(json, "utf8")).toString("base64");
    },
    keyParts,
    opts
  );
  return reactCache(async () => {
    const blob = await loadCompressedBlob();
    const json = gunzipSync(Buffer.from(blob, "base64")).toString("utf8");
    return JSON.parse(json) as Facility[];
  });
}

/**
 * Cached, deterministically-ordered facility loader tagged `"facilities"`,
 * refreshed at most hourly. This is the **aggregate-only** reader now — it
 * backs the ~15 aggregate pages (home, map, table, stats, explore lenses,
 * operators/states index, sitemap, OG image) that legitimately need the
 * whole dataset. Scoped pages (facility detail, one state, one operator)
 * must use the per-scope cached readers below instead, so they don't
 * re-acquire the `"facilities"` tag or this timer.
 *
 * `revalidate: 3600` bounds staleness to ~1h — approved tolerance for
 * aggregate rollups (Ed, 2026-07-22 ISR-write-blowout fix). Combined with
 * dropping the on-write `revalidateTag("facilities")` nuke (see
 * `lib/facility-write.ts`), aggregate pages now refresh on this cheap timer
 * instead of on every write.
 *
 * `unstable_cache` requires the Next.js request-scoped cache context, which
 * is absent under vitest — detect that environment and degrade to the
 * uncached loader directly so the 536-test suite (which runs with no
 * DATABASE_URL, exercising the JSON fallback) stays green. The underlying
 * payload is stored gzip-compressed (see `loadFacilitiesCompressed` above)
 * to stay well under `unstable_cache`'s 2MB entry limit.
 */
export const loadFacilities: () => Promise<Facility[]> = process.env.VITEST
  ? loadFacilitiesUncached
  : loadFacilitiesCompressed(["facilities"], {
      tags: ["facilities"],
      revalidate: 3600,
    });

/**
 * 24h-revalidate view of the facility list for the GLOBAL ⌘K search index ONLY.
 * <SiteHeader> renders it in the root layout on every route, so this read's
 * revalidate becomes the site-wide ISR floor — deliberately long (86400s) so it
 * does NOT pin every page to a 1h cycle. Aggregate pages read loadFacilities
 * (1h) directly and float above this floor; detail/state pages read scoped
 * tag-only caches and floor here at 24h.
 *
 * Deliberately NO cache tag here — do NOT add one back (not "facilities", not
 * "search-index", not anything). A tag on a root-layout read gets stamped onto
 * every prerendered route (~1,500 of them), so busting it hard-expires the
 * whole site in one shot. This used to carry the "facilities" tag, reasoned
 * at the time to be inert because nothing called revalidateTag("facilities").
 * That premise held only until `scripts/sync-to-neon.ts` started adding
 * "facilities" to every publish's tag set — at which point this read turned
 * every `db:sync -- --apply` into a site-wide cache nuke. Measured 2026-08-21.
 * The 86400s timer above is the intended refresh mechanism for this reader;
 * it needs no tag to stay correct. Gzip-compressed for the same 2MB-ceiling
 * reason as `loadFacilities` above.
 */
export const loadFacilitiesForSearch: () => Promise<Facility[]> = process.env.VITEST
  ? loadFacilitiesUncached
  : loadFacilitiesCompressed(["facilities-search"], {
      revalidate: 86400,
    });

// ============================================================
// Scoped cached readers (per-facility / per-state / power-generation)
// ============================================================
//
// These back the pages that must NOT depend on the global `"facilities"`
// tag or its 1h timer: facility detail, state landing, and (indirectly, via
// loadPowerGenerationCached) the power-links cross-reference on detail
// pages. Each is tag-only (no `revalidate` option) so the page stays fully
// static and rewrites only when `lib/facility-write.ts` busts its specific
// tag on write. Each reads the DB/JSON directly rather than routing through
// `loadFacilities()`, so it never re-acquires the global tag. Every reader
// mirrors the `process.env.VITEST` bypass so the test suite (no
// DATABASE_URL) stays green.

/**
 * Uncached direct-row fetch backing `getFacilityByIdCached`. The DB branch
 * retries transient Neon read failures before degrading to the matching
 * record in the JSON snapshot (see `withJsonFallback`).
 */
async function fetchFacilityByIdUncached(id: string): Promise<Facility | undefined> {
  if (hasDatabaseUrl()) {
    return withJsonFallback(
      async () => {
        const rows = await getDb().select().from(facilitiesTable).where(eq(facilitiesTable.id, id));
        return rows[0] ? rowToFacility(rows[0]) : undefined;
      },
      () => loadFromJson().find((f) => f.id === id)
    );
  }
  return loadFromJson().find((f) => f.id === id);
}

/**
 * Per-facility scoped reader for the facility detail page. Tagged
 * `facility:${id}` — busted only by a write to that specific facility (see
 * `revalidateForFacility` in `lib/facility-write.ts`), never by the global
 * `"facilities"` tag or a timer.
 */
export const getFacilityByIdCached = (id: string): Promise<Facility | undefined> =>
  process.env.VITEST
    ? fetchFacilityByIdUncached(id)
    : unstable_cache(fetchFacilityByIdUncached, ["facility", id], {
        tags: [`facility:${id}`],
      })(id);

/**
 * Uncached direct-filtered fetch backing `getFacilitiesByStateCached`. The DB
 * branch retries transient Neon read failures before degrading to the JSON
 * snapshot (see `withJsonFallback`/`selectAllFacilitiesResilient`).
 */
async function fetchFacilitiesByStateUncached(code: string): Promise<Facility[]> {
  const upper = code.toUpperCase();
  const list = hasDatabaseUrl() ? await selectAllFacilitiesResilient() : loadFromJson();
  return list
    .filter((f) => f.location.state === upper)
    .sort(
      (a, b) =>
        (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
        a.name.localeCompare(b.name)
    );
}

/**
 * Per-state scoped reader for the state landing page. Tagged
 * `state:${CODE}` (uppercase) — busted only by a write touching that state,
 * never by the global tag or timer. Same filter/sort as `getFacilitiesByState`.
 */
export const getFacilitiesByStateCached = (code: string): Promise<Facility[]> => {
  const upper = code.toUpperCase();
  return process.env.VITEST
    ? fetchFacilitiesByStateUncached(upper)
    : unstable_cache(fetchFacilitiesByStateUncached, ["facilities-by-state", upper], {
        tags: [`state:${upper}`],
      })(upper);
};

/** Uncached direct-filtered summary backing `getStateSummaryCached`. */
async function fetchStateSummaryUncached(code: string): Promise<StateSummary | null> {
  const upper = code.toUpperCase();
  const stateFacilities = await fetchFacilitiesByStateUncached(upper);
  return computeStateSummary(upper, stateFacilities);
}

/**
 * Per-state scoped summary reader for the state landing page. Tagged
 * `state:${CODE}` — same tag as `getFacilitiesByStateCached` so one write
 * busts both. Same math as `getStateSummary`.
 */
export const getStateSummaryCached = (code: string): Promise<StateSummary | null> => {
  const upper = code.toUpperCase();
  return process.env.VITEST
    ? fetchStateSummaryUncached(upper)
    : unstable_cache(fetchStateSummaryUncached, ["state-summary", upper], {
        tags: [`state:${upper}`],
      })(upper);
};

/**
 * Uncached full power_generation-facility load backing
 * `loadPowerGenerationCached`. The DB branch retries transient Neon read
 * failures before degrading to the JSON snapshot (see
 * `withJsonFallback`/`selectAllFacilitiesResilient`).
 */
async function loadPowerGenerationUncached(): Promise<PowerGenerationFacility[]> {
  const list = hasDatabaseUrl() ? await selectAllFacilitiesResilient() : loadFromJson();
  return list.filter(
    (f): f is PowerGenerationFacility => f.facilityType === "power_generation"
  );
}

/**
 * Tag-only cached power_generation-facility loader, decoupled from the
 * global `"facilities"` tag/timer so the facility detail page's "Powered
 * by" / "Powers" cross-reference (see `getPoweredCampuses` /
 * `getPoweredByGenerators` below) doesn't reintroduce a dependency on the
 * 1h-global cache. Tagged `power-generation` — busted whenever a write
 * touches a power_generation facility (either side of a link).
 */
export const loadPowerGenerationCached: () => Promise<PowerGenerationFacility[]> =
  process.env.VITEST
    ? loadPowerGenerationUncached
    : unstable_cache(loadPowerGenerationUncached, ["power-generation"], {
        tags: ["power-generation"],
      });

export async function getAllFacilities(): Promise<Facility[]> {
  return loadFacilities();
}

export async function getFacilityById(id: string): Promise<Facility | undefined> {
  const facilities = await loadFacilities();
  return facilities.find((f) => f.id === id);
}

/** Returns unique 2-letter state codes, sorted A→Z. */
export async function getStates(): Promise<string[]> {
  const facilities = await loadFacilities();
  return [...new Set(facilities.map((f) => f.location.state))].sort();
}

/** Returns unique operator names, sorted A→Z. */
export async function getOperators(): Promise<string[]> {
  const facilities = await loadFacilities();
  return [...new Set(facilities.map((f) => f.operator))].sort();
}

/** Returns a count per status for all facilities (all 5 statuses always present). */
export async function getStatusCounts(): Promise<Record<Status, number>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    STATUS_ORDER.map((s) => [s, 0])
  ) as Record<Status, number>;
  for (const f of facilities) {
    counts[f.status]++;
  }
  return counts;
}

/**
 * Returns all facilities with the given status, sorted by max capacity
 * (operational or planned) desc, then name A→Z (deterministic tie-break).
 * Backs the /status/[status] landing pages. Reads the shared
 * `loadFacilities()` cache — no new uncached per-request DB read (see that
 * function's doc comment on the s51 ISR-write-blowout lesson).
 */
export async function getFacilitiesByStatus(status: Status): Promise<Facility[]> {
  const facilities = await loadFacilities();
  return facilities
    .filter((f) => f.status === status)
    .sort(
      (a, b) =>
        (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
        a.name.localeCompare(b.name)
    );
}

/**
 * Returns aggregate stats for the whole dataset.
 *
 * `operationalMw` — sum of `capacityMw.operational` across non-cancelled facilities.
 * `plannedMw`     — sum of `capacityMw.planned` across non-cancelled facilities.
 * Both lenses exclude cancelled projects so the displayed figures are not
 * inflated by withdrawn announcements. They are intentionally independent
 * (running vs announced) rather than a combined max/total.
 */
export async function getStats(): Promise<{
  count: number;
  states: number;
  operationalMw: number;
  plannedMw: number;
  underConstructionMw: number;
}> {
  const facilities = await loadFacilities();
  const count = facilities.length;
  const states = new Set(facilities.map((f) => f.location.state)).size;
  const active = facilities.filter((f) => f.status !== "cancelled");
  const operationalMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.operational ?? 0),
    0
  );
  const plannedMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.planned ?? 0),
    0
  );
  const underConstructionMw = facilities
    .filter((f) => f.status === "under_construction")
    .reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
  return { count, states, operationalMw, plannedMw, underConstructionMw };
}

// ============================================================
// Dataset-coverage helpers (used by /stats aggregate page)
// ============================================================

/**
 * Per-dimension counts of facilities carrying at least one substantive value.
 * Each dimension predicate matches the documented coverage counts verified
 * 2026-07-07 — do not alter the predicates.
 */
export interface CivicCoverage {
  energy: number;
  water: number;
  subsidies: number;
  investment: number;
  jobs: number;
  community: number;
}

/** Returns the count of facilities with at least one sourced value per civic dimension. */
export async function getCivicCoverage(): Promise<CivicCoverage> {
  const facilities = await loadFacilities();
  let energy = 0, water = 0, subsidies = 0, investment = 0, jobs = 0, community = 0;
  for (const f of facilities) {
    if (!!f.energy && !!(f.energy.source || f.energy.utility || f.energy.onSiteGenerationMw != null || f.energy.notes)) energy++;
    if (!!f.water && !!(f.water.coolingType || f.water.reportedMgd != null || f.water.notes)) water++;
    if (Array.isArray(f.subsidies) && f.subsidies.length > 0) subsidies++;
    if (f.investmentUsd != null) investment++;
    if (!!f.jobs && (f.jobs.construction != null || f.jobs.permanent != null)) jobs++;
    if (!!f.community && !!(f.community.status || f.community.notes)) community++;
  }
  return { energy, water, subsidies, investment, jobs, community };
}

/**
 * Returns the top-N states by facility count, sorted by count desc then state A→Z
 * (deterministic tie-break).
 */
export async function getTopStates(n = 10): Promise<{ state: string; count: number }[]> {
  const facilities = await loadFacilities();
  const stateCounts = new Map<string, number>();
  for (const f of facilities) {
    stateCounts.set(f.location.state, (stateCounts.get(f.location.state) ?? 0) + 1);
  }
  return [...stateCounts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state))
    .slice(0, n);
}

/**
 * Returns the top-N operators by facility count, sorted by count desc then operator A→Z
 * (deterministic tie-break).
 */
export async function getTopOperators(n = 10): Promise<{ operator: string; count: number }[]> {
  const facilities = await loadFacilities();
  const opCounts = new Map<string, number>();
  for (const f of facilities) {
    opCounts.set(f.operator, (opCounts.get(f.operator) ?? 0) + 1);
  }
  return [...opCounts.entries()]
    .map(([operator, count]) => ({ operator, count }))
    .sort((a, b) => b.count - a.count || a.operator.localeCompare(b.operator))
    .slice(0, n);
}

/**
 * Returns a count per AI classification across data-center facilities only.
 * `aiClassification` is optional on the `crypto_mining` union branch, so
 * non-data-center facilities (and data-center records that somehow omit it)
 * are excluded from the tally.
 * Seeds all keys from `aiClassificationEnum.options` at 0 before tallying.
 */
export async function getAiClassificationCounts(): Promise<Record<
  z.infer<typeof aiClassificationEnum>,
  number
>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    aiClassificationEnum.options.map((k) => [k, 0])
  ) as Record<z.infer<typeof aiClassificationEnum>, number>;
  for (const f of facilities) {
    if (f.facilityType === "data_center" && f.aiClassification) {
      counts[f.aiClassification]++;
    }
  }
  return counts;
}

/**
 * Returns AI classification counts grouped by state, across data-center
 * facilities only (mirrors the `getAiClassificationCounts` exclusion logic).
 * Each state's record seeds all keys from `aiClassificationEnum.options` at 0
 * before tallying. States with no AI-classified data-center facility are
 * omitted entirely (no all-zero rows). Sorted by total AI-classified count
 * desc, then state A→Z (deterministic tie-break).
 */
export async function getAiClassificationByState(): Promise<
  { state: string; counts: Record<z.infer<typeof aiClassificationEnum>, number> }[]
> {
  const facilities = await loadFacilities();
  const byState = new Map<string, Record<z.infer<typeof aiClassificationEnum>, number>>();
  for (const f of facilities) {
    if (f.facilityType !== "data_center" || !f.aiClassification) continue;
    const state = f.location.state;
    if (!byState.has(state)) {
      byState.set(
        state,
        Object.fromEntries(
          aiClassificationEnum.options.map((k) => [k, 0])
        ) as Record<z.infer<typeof aiClassificationEnum>, number>
      );
    }
    byState.get(state)![f.aiClassification]++;
  }
  return [...byState.entries()]
    .map(([state, counts]) => ({ state, counts }))
    .sort((a, b) => {
      const totalA = Object.values(a.counts).reduce((sum, n) => sum + n, 0);
      const totalB = Object.values(b.counts).reduce((sum, n) => sum + n, 0);
      return totalB - totalA || a.state.localeCompare(b.state);
    });
}

/**
 * Returns AI classification counts for a single state, across data-center
 * facilities only (mirrors the `getAiClassificationCounts` exclusion logic).
 * Seeds all keys from `aiClassificationEnum.options` at 0 before tallying,
 * so a state with no AI-classified data-center facility gracefully returns
 * an all-zero record.
 */
export async function getStateAiClassificationCounts(
  code: string
): Promise<Record<z.infer<typeof aiClassificationEnum>, number>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    aiClassificationEnum.options.map((k) => [k, 0])
  ) as Record<z.infer<typeof aiClassificationEnum>, number>;
  for (const f of facilities) {
    if (f.facilityType === "data_center" && f.aiClassification && f.location.state === code) {
      counts[f.aiClassification]++;
    }
  }
  return counts;
}

/**
 * Returns a count per confidence level for all facilities.
 * Seeds all keys from `confidenceEnum.options` at 0 before tallying.
 */
export async function getConfidenceCounts(): Promise<Record<Facility["confidence"], number>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    confidenceEnum.options.map((k) => [k, 0])
  ) as Record<Facility["confidence"], number>;
  for (const f of facilities) {
    counts[f.confidence]++;
  }
  return counts;
}

/**
 * Returns a count per facility type for all facilities.
 * Seeds both keys from `FACILITY_TYPE_ORDER` at 0 before tallying.
 */
export async function getFacilityTypeCounts(): Promise<Record<FacilityType, number>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    FACILITY_TYPE_ORDER.map((k) => [k, 0])
  ) as Record<FacilityType, number>;
  for (const f of facilities) {
    counts[f.facilityType]++;
  }
  return counts;
}

/**
 * Returns a count per community reception status across facilities that
 * carry a sourced `community.status` value. Facilities with no
 * `community.status` at all are not counted in any bucket — "unknown" is
 * itself an explicit sourced value, distinct from "not reported."
 * Seeds all 6 keys from `COMMUNITY_RECEPTION_ORDER` at 0 before tallying.
 */
export async function getCommunityReceptionCounts(): Promise<Record<CommunityReception, number>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    COMMUNITY_RECEPTION_ORDER.map((k) => [k, 0])
  ) as Record<CommunityReception, number>;
  for (const f of facilities) {
    if (f.community?.status) {
      counts[f.community.status]++;
    }
  }
  return counts;
}

/** Returns the top-N facilities sorted by highest capacity (operational or planned). */
export async function getNotableFacilities(n = 6): Promise<Facility[]> {
  const facilities = await loadFacilities();
  return [...facilities]
    .sort(
      (a, b) =>
        Math.max(b.capacityMw?.operational ?? 0, b.capacityMw?.planned ?? 0) -
        Math.max(a.capacityMw?.operational ?? 0, a.capacityMw?.planned ?? 0)
    )
    .slice(0, n);
}

// ============================================================
// Capacity-ranking helpers (used by the /rankings hub)
// ============================================================

/**
 * Hard guard against the dataset's UT/WY multi-GW unverified megaprojects
 * (3-10 GW single-facility claims per ROADMAP) inflating the capacity
 * rankings below. True when a facility's planned capacity exceeds 2,000 MW
 * AND its confidence is not `"confirmed"` — 2,000 MW sits safely below the
 * smallest cited outlier while comfortably above any real single confirmed
 * campus. Gated at the single-facility level, never on an aggregate total:
 * a legitimate state or operator with many small confirmed/reported
 * facilities that sum past 2 GW is never penalized by this guard — only the
 * actual outlier record is excluded from the ranking helpers below.
 */
function isUnverifiedMegaproject(f: Facility): boolean {
  return (f.capacityMw?.planned ?? 0) > 2000 && f.confidence !== "confirmed";
}

/**
 * Returns up to `n` facilities ranked by planned capacity
 * (`capacityMw.planned`) descending, tie-broken by name A→Z. Excludes
 * cancelled facilities and `isUnverifiedMegaproject` outliers before
 * ranking. Mirrors `getFacilitiesByWaterUsage`'s filter→sort→slice shape
 * (Session 7, Task 7.1) applied to `capacityMw.planned` instead.
 */
export async function getFacilitiesRankedByPlannedMw(n = 20): Promise<Facility[]> {
  const facilities = await loadFacilities();
  return facilities
    .filter(
      (f) =>
        f.status !== "cancelled" &&
        !isUnverifiedMegaproject(f) &&
        typeof f.capacityMw?.planned === "number" &&
        f.capacityMw.planned > 0
    )
    .sort(
      (a, b) =>
        b.capacityMw!.planned! - a.capacityMw!.planned! || a.name.localeCompare(b.name)
    )
    .slice(0, n);
}

/** One operator's aggregate capacity ranking, used by the /rankings hub. */
export interface OperatorCapacityRanking {
  operator: string;
  /** Sum of capacityMw.operational across the operator's non-cancelled, non-outlier facilities. */
  operationalMw: number;
  /** Sum of capacityMw.planned across the operator's non-cancelled, non-outlier facilities. */
  plannedMw: number;
  /** Count of the operator's non-outlier facilities (any status) — mirrors getTopOperators' unfiltered count. */
  count: number;
}

/**
 * Returns the top-N operators by combined capacity (operationalMw +
 * plannedMw) desc, then operator A→Z (deterministic tie-break). Groups
 * `isUnverifiedMegaproject`-filtered facilities by operator, mirroring the
 * `opCounts` Map pattern in `getTopOperators`/`computeStateSummary` (same
 * file); sums `capacityMw.operational`/`capacityMw.planned` across
 * non-cancelled facilities per operator, mirroring `getStats`' capacity math.
 */
export async function getTopOperatorsByCapacity(n = 10): Promise<OperatorCapacityRanking[]> {
  const facilities = await loadFacilities();
  const byOperator = new Map<
    string,
    { operationalMw: number; plannedMw: number; count: number }
  >();
  for (const f of facilities) {
    if (isUnverifiedMegaproject(f)) continue;
    const entry = byOperator.get(f.operator) ?? { operationalMw: 0, plannedMw: 0, count: 0 };
    entry.count++;
    if (f.status !== "cancelled") {
      entry.operationalMw += f.capacityMw?.operational ?? 0;
      entry.plannedMw += f.capacityMw?.planned ?? 0;
    }
    byOperator.set(f.operator, entry);
  }
  return [...byOperator.entries()]
    .map(([operator, agg]) => ({ operator, ...agg }))
    .sort(
      (a, b) =>
        b.operationalMw + b.plannedMw - (a.operationalMw + a.plannedMw) ||
        a.operator.localeCompare(b.operator)
    )
    .slice(0, n);
}

/** One state's aggregate capacity ranking, used by the /rankings hub. */
export interface StateCapacityRanking {
  state: string;
  /** Sum of capacityMw.operational across the state's non-cancelled, non-outlier facilities. */
  operationalMw: number;
  /** Sum of capacityMw.planned across the state's non-cancelled, non-outlier facilities. */
  plannedMw: number;
  /** Count of the state's non-outlier facilities (any status) — mirrors getTopOperators' unfiltered count. */
  count: number;
}

/**
 * Returns the top-N states by combined capacity (operationalMw + plannedMw)
 * desc, then state A→Z (deterministic tie-break). Identical shape to
 * `getTopOperatorsByCapacity`, grouped by `location.state` instead of
 * `operator` — same outlier exclusion, same non-cancelled capacity math.
 */
export async function getTopStatesByCapacity(n = 10): Promise<StateCapacityRanking[]> {
  const facilities = await loadFacilities();
  const byState = new Map<
    string,
    { operationalMw: number; plannedMw: number; count: number }
  >();
  for (const f of facilities) {
    if (isUnverifiedMegaproject(f)) continue;
    const state = f.location.state;
    const entry = byState.get(state) ?? { operationalMw: 0, plannedMw: 0, count: 0 };
    entry.count++;
    if (f.status !== "cancelled") {
      entry.operationalMw += f.capacityMw?.operational ?? 0;
      entry.plannedMw += f.capacityMw?.planned ?? 0;
    }
    byState.set(state, entry);
  }
  return [...byState.entries()]
    .map(([state, agg]) => ({ state, ...agg }))
    .sort(
      (a, b) =>
        b.operationalMw + b.plannedMw - (a.operationalMw + a.plannedMw) ||
        a.state.localeCompare(b.state)
    )
    .slice(0, n);
}

// ============================================================
// Water use helpers (used by /stats Water use section)
// ============================================================

export interface WaterUsage {
  /** Non-cancelled facilities disclosing a positive daily water figure. */
  reportingCount: number;
  /** Sum of reportedMgd (million gallons/day) across those facilities. */
  totalMgd: number;
}

/** Non-cancelled facility disclosing a positive `water.reportedMgd` figure. */
function hasReportedWater(f: Facility): boolean {
  return (
    f.status !== "cancelled" &&
    typeof f.water?.reportedMgd === "number" &&
    f.water.reportedMgd > 0
  );
}

/**
 * Returns the count and total daily water usage (MGD) across non-cancelled
 * facilities that disclose a positive `water.reportedMgd` figure.
 * This is a reported floor — most facilities do not publish a daily water figure.
 */
export async function getWaterUsage(): Promise<WaterUsage> {
  const facilities = await loadFacilities();
  const reporting = facilities.filter(hasReportedWater);
  const totalMgd = reporting.reduce((sum, f) => sum + (f.water!.reportedMgd!), 0);
  return { reportingCount: reporting.length, totalMgd };
}

/** All 5 cooling type keys (stable, exhaustive set). */
const COOLING_TYPE_KEYS = [
  "evaporative",
  "air",
  "closed_loop",
  "hybrid",
  "unknown",
] as const;

export type CoolingType = (typeof COOLING_TYPE_KEYS)[number];

/**
 * Returns a count per cooling type among non-cancelled facilities that declare
 * `water.coolingType`. All 5 keys are always present (seeded at 0).
 */
export async function getCoolingTypeCounts(): Promise<Record<CoolingType, number>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    COOLING_TYPE_KEYS.map((k) => [k, 0])
  ) as Record<CoolingType, number>;
  for (const f of facilities) {
    if (f.status !== "cancelled" && f.water?.coolingType) {
      counts[f.water.coolingType]++;
    }
  }
  return counts;
}

/**
 * Returns up to `n` facilities ranked by reported daily water usage
 * (`water.reportedMgd`) descending, tie-broken by name A→Z. Uses the same
 * non-cancelled + positive-reportedMgd filter as `getWaterUsage`.
 */
export async function getFacilitiesByWaterUsage(n = 10): Promise<Facility[]> {
  const facilities = await loadFacilities();
  return facilities
    .filter(hasReportedWater)
    .sort((a, b) => b.water!.reportedMgd! - a.water!.reportedMgd! || a.name.localeCompare(b.name))
    .slice(0, n);
}

// ============================================================
// Energy source helpers (used by /stats § Energy section)
// ============================================================

/** All 8 energy source keys (stable, exhaustive set — mirrors schema `energy.source` enum). */
const ENERGY_SOURCE_KEYS = [
  "grid",
  "on_site_gas",
  "nuclear",
  "solar",
  "wind",
  "hydro",
  "mixed",
  "other",
] as const;

export type EnergySource = (typeof ENERGY_SOURCE_KEYS)[number];

/**
 * Returns a count per energy source among facilities that declare
 * `energy.source`. All 8 keys are always present (seeded at 0).
 */
export async function getEnergySourceCounts(): Promise<Record<EnergySource, number>> {
  const facilities = await loadFacilities();
  const counts = Object.fromEntries(
    ENERGY_SOURCE_KEYS.map((k) => [k, 0])
  ) as Record<EnergySource, number>;
  for (const f of facilities) {
    if (f.energy?.source) {
      counts[f.energy.source]++;
    }
  }
  return counts;
}

// ============================================================
// Per-state helpers (used by state landing pages)
// ============================================================

/**
 * Returns all facilities whose primary `location.state` matches `code`
 * (case-insensitive), sorted by max capacity (operational or planned) desc,
 * then name A→Z (deterministic tie-break).
 */
export async function getFacilitiesByState(code: string): Promise<Facility[]> {
  const facilities = await loadFacilities();
  const upper = code.toUpperCase();
  return facilities
    .filter((f) => f.location.state === upper)
    .sort(
      (a, b) =>
        (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
        a.name.localeCompare(b.name)
    );
}

/** Aggregate summary of one state's facilities. */
export interface StateSummary {
  /** Uppercase 2-letter state code, e.g. "NY". */
  code: string;
  count: number;
  /** Sum of capacityMw.operational across non-cancelled facilities. */
  operationalMw: number;
  /** Sum of capacityMw.planned across non-cancelled facilities. */
  plannedMw: number;
  /** Sum of capacityMw.planned across facilities under_construction. */
  underConstructionMw: number;
  byType: Record<FacilityType, number>;
  byStatus: Record<Status, number>;
  /** Count with community.status in {contested, opposed, litigation}. */
  communityFriction: number;
  /** Count with any community.status set (sourced, including "unknown"). */
  communityReporting: number;
  /** In-state operators, count desc then operator A→Z (deterministic tie-break). */
  topOperators: { operator: string; count: number }[];
}

/**
 * Shared aggregation core for `getStateSummary` and `getStateSummaryCached`
 * — both receive an already-filtered `stateFacilities` list (from
 * `loadFacilities()` global or the scoped direct DB/JSON read
 * respectively) and just need the same rollup math applied. Mirrors
 * `getStats`' capacity math (excludes cancelled for operational/planned)
 * and `getTopOperators`' tie-break for `topOperators`.
 */
function computeStateSummary(upper: string, stateFacilities: Facility[]): StateSummary | null {
  const count = stateFacilities.length;
  if (count === 0) {
    return null;
  }

  const active = stateFacilities.filter((f) => f.status !== "cancelled");
  const operationalMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.operational ?? 0),
    0
  );
  const plannedMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.planned ?? 0),
    0
  );
  const underConstructionMw = stateFacilities
    .filter((f) => f.status === "under_construction")
    .reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);

  const byType = Object.fromEntries(
    FACILITY_TYPE_ORDER.map((k) => [k, 0])
  ) as Record<FacilityType, number>;
  const byStatus = Object.fromEntries(
    STATUS_ORDER.map((k) => [k, 0])
  ) as Record<Status, number>;
  let communityFriction = 0;
  let communityReporting = 0;
  const opCounts = new Map<string, number>();

  for (const f of stateFacilities) {
    byType[f.facilityType]++;
    byStatus[f.status]++;
    if (f.community?.status) {
      communityReporting++;
      if (
        f.community.status === "contested" ||
        f.community.status === "opposed" ||
        f.community.status === "litigation"
      ) {
        communityFriction++;
      }
    }
    opCounts.set(f.operator, (opCounts.get(f.operator) ?? 0) + 1);
  }

  const topOperators = [...opCounts.entries()]
    .map(([operator, opCount]) => ({ operator, count: opCount }))
    .sort((a, b) => b.count - a.count || a.operator.localeCompare(b.operator));

  return {
    code: upper,
    count,
    operationalMw,
    plannedMw,
    underConstructionMw,
    byType,
    byStatus,
    communityFriction,
    communityReporting,
    topOperators,
  };
}

/**
 * Returns an aggregate summary for one state, or null when the state has
 * zero facilities. Reads the global `loadFacilities()` cache — used by
 * admin/other callers that already hold the full set. The state landing
 * page should use `getStateSummaryCached` instead (scoped tag, no global
 * dependency).
 */
export async function getStateSummary(code: string): Promise<StateSummary | null> {
  const facilities = await loadFacilities();
  const upper = code.toUpperCase();
  const stateFacilities = facilities.filter((f) => f.location.state === upper);
  return computeStateSummary(upper, stateFacilities);
}

// ============================================================
// Power-generation helpers (used by /power)
// ============================================================

/** All power_generation facilities (type-guarded so `.generation` narrows). */
export async function getPowerGenerationFacilities(): Promise<PowerGenerationFacility[]> {
  const facilities = await loadFacilities();
  return facilities.filter(
    (f): f is PowerGenerationFacility => f.facilityType === "power_generation"
  );
}

/**
 * Normalizes an offtaker string for grouping: strips a trailing
 * parenthetical, e.g. "Amazon (AWS)" -> "Amazon". Facilities recording the
 * same buyer under different spellings collapse into one group.
 */
export function normalizeOfftaker(offtaker: string): string {
  return offtaker.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** One offtaker's power-generation facilities, aggregated for /power § By offtaker. */
export interface OfftakerGroup {
  /** Normalized display name, e.g. "Amazon". */
  offtaker: string;
  /** Sorted by max capacity (operational or planned) desc, then name A→Z. */
  facilities: PowerGenerationFacility[];
  /** Sum of getFacilityMaxMw across the group. */
  totalMw: number;
}

/**
 * Returns power_generation facilities grouped by normalized offtaker,
 * sorted by totalMw desc then offtaker A→Z (deterministic tie-break).
 * Facilities with no `generation.offtaker` are excluded — they have no
 * buyer to group under.
 */
export async function getGenerationByOfftaker(): Promise<OfftakerGroup[]> {
  const groups = new Map<string, PowerGenerationFacility[]>();
  for (const f of await getPowerGenerationFacilities()) {
    const offtaker = f.generation?.offtaker;
    if (!offtaker) continue;
    const key = normalizeOfftaker(offtaker);
    const existing = groups.get(key);
    if (existing) {
      existing.push(f);
    } else {
      groups.set(key, [f]);
    }
  }

  return [...groups.entries()]
    .map(([offtaker, groupFacilities]) => {
      const sorted = [...groupFacilities].sort(
        (a, b) =>
          (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
          a.name.localeCompare(b.name)
      );
      const totalMw = sorted.reduce(
        (sum, f) => sum + (getFacilityMaxMw(f) ?? 0),
        0
      );
      return { offtaker, facilities: sorted, totalMw };
    })
    .sort((a, b) => b.totalMw - a.totalMw || a.offtaker.localeCompare(b.offtaker));
}

/** Aggregate stats for the power_generation layer, used by /power's survey-stat row. */
export interface GenerationStats {
  /** Number of power_generation projects. */
  count: number;
  /** Sum of capacityMw.operational across non-cancelled power_generation projects. */
  operationalMw: number;
  /** Sum of capacityMw.planned across non-cancelled power_generation projects. */
  plannedMw: number;
  /** Distinct normalized offtakers among projects that disclose one. */
  offtakerCount: number;
}

/**
 * Returns aggregate stats for the power_generation facility layer. Mirrors
 * getStats' capacity math (excludes cancelled for operational/planned).
 */
export async function getGenerationStats(): Promise<GenerationStats> {
  const generation = await getPowerGenerationFacilities();
  const active = generation.filter((f) => f.status !== "cancelled");
  const operationalMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.operational ?? 0),
    0
  );
  const plannedMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.planned ?? 0),
    0
  );
  const offtakers = new Set(
    generation
      .map((f) => f.generation?.offtaker)
      .filter((o): o is string => !!o)
      .map(normalizeOfftaker)
  );
  return {
    count: generation.length,
    operationalMw,
    plannedMw,
    offtakerCount: offtakers.size,
  };
}

/**
 * Compute campuses a power_generation facility explicitly powers, resolved from
 * its sourced `generation.poweredFacilityIds`. Returns [] for non-power_generation
 * facilities. Dangling ids (no matching facility) are skipped so render code never
 * crashes — a data-integrity test guards against them existing. Sorted by max
 * capacity (operational or planned) desc, then name A→Z.
 *
 * Resolves each id via `getFacilityByIdCached` (per-id scoped tag), not the
 * global `getFacilityById`/`loadFacilities()` — called from the facility
 * detail page's power-links section, which must not carry the global
 * `"facilities"` tag or its 1h timer (see `loadFacilities` doc comment).
 */
export async function getPoweredCampuses(facility: Facility): Promise<Facility[]> {
  if (facility.facilityType !== "power_generation") return [];
  const ids = facility.generation?.poweredFacilityIds ?? [];
  const resolved = await Promise.all(ids.map((id) => getFacilityByIdCached(id)));
  return resolved
    .filter((f): f is Facility => f !== undefined)
    .sort(
      (a, b) =>
        (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
        a.name.localeCompare(b.name)
    );
}

/**
 * Reverse lookup: power_generation facilities that explicitly list `facility.id`
 * in their `generation.poweredFacilityIds`. The "Powered by" direction is derived
 * here rather than stored on the compute record (single source of truth). Sorted
 * by max capacity (operational or planned) desc, then name A→Z.
 *
 * Reads `loadPowerGenerationCached()` (tag `power-generation`), not
 * `getPowerGenerationFacilities()`/`loadFacilities()` — same reasoning as
 * `getPoweredCampuses` above: this backs the facility detail page's
 * cross-reference and must stay decoupled from the global tag/timer.
 */
export async function getPoweredByGenerators(facility: Facility): Promise<PowerGenerationFacility[]> {
  const generation = await loadPowerGenerationCached();
  return generation
    .filter((g) => (g.generation?.poweredFacilityIds ?? []).includes(facility.id))
    .sort(
      (a, b) =>
        (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
        a.name.localeCompare(b.name)
    );
}

// ============================================================
// Crypto-mining helpers (used by /crypto)
// ============================================================

/** All crypto_mining facilities (type-guarded so `.mining`-shaped fields narrow). */
export async function getCryptoMiningFacilities(): Promise<CryptoMiningFacility[]> {
  const facilities = await loadFacilities();
  return facilities.filter(
    (f): f is CryptoMiningFacility => f.facilityType === "crypto_mining"
  );
}

/** Aggregate stats for the crypto_mining layer, used by /crypto's survey-stat row. */
export interface CryptoMiningStats {
  /** Number of crypto_mining facilities. */
  count: number;
  /** Sum of capacityMw.operational across non-cancelled crypto_mining facilities. */
  operationalMw: number;
  /** Sum of capacityMw.planned across non-cancelled crypto_mining facilities. */
  plannedMw: number;
  /** Distinct states among all crypto_mining facilities. */
  stateCount: number;
}

/**
 * Returns aggregate stats for the crypto_mining facility layer. Mirrors
 * getGenerationStats' capacity math (excludes cancelled for operational/planned).
 */
export async function getCryptoMiningStats(): Promise<CryptoMiningStats> {
  const mining = await getCryptoMiningFacilities();
  const active = mining.filter((f) => f.status !== "cancelled");
  const operationalMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.operational ?? 0),
    0
  );
  const plannedMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.planned ?? 0),
    0
  );
  const states = new Set(mining.map((f) => f.location.state));
  return {
    count: mining.length,
    operationalMw,
    plannedMw,
    stateCount: states.size,
  };
}

// ============================================================
// Community-friction helpers (used by /opposition)
// ============================================================

/** Facilities whose community.status matches `status`, sorted by max capacity desc then name A→Z. */
export async function getFacilitiesByCommunityStatus(status: CommunityReception): Promise<Facility[]> {
  const facilities = await loadFacilities();
  return facilities
    .filter((f) => f.community?.status === status)
    .sort((a, b) => (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) || a.name.localeCompare(b.name));
}

/**
 * Returns up to `n` "notable" opposition cases: facilities whose
 * `community.status` is one of the friction statuses (contested, opposed,
 * litigation) AND that carry sourced `community.notes` — i.e. a citable
 * narrative, not just a bucketed status. Sorted by max capacity desc then
 * name A→Z (same tie-break as `getFacilitiesByCommunityStatus`). Used by
 * the /opposition hub to spotlight cases with an actual documented story.
 */
export async function getNotableOppositionCases(n = 6): Promise<Facility[]> {
  const facilities = await loadFacilities();
  const frictionStatuses: CommunityReception[] = ["contested", "opposed", "litigation"];
  return facilities
    .filter(
      (f) =>
        !!f.community?.status &&
        frictionStatuses.includes(f.community.status) &&
        !!f.community?.notes
    )
    .sort((a, b) => (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) || a.name.localeCompare(b.name))
    .slice(0, n);
}

/**
 * Facilities that were CANCELLED after facing documented local opposition —
 * top-level status "cancelled" AND a friction community.status
 * (contested | opposed | litigation). This is the *outcome* dimension of the
 * /opposition hub: projects that did not proceed and had sourced pushback on
 * record. NOTE: this is a correlation (cancelled + opposed), NOT a causal
 * claim that opposition stopped the project — a cancellation may have other
 * causes. Excludes cancellations whose community.status is "supported"/"mixed"
 * (not opposition-related). Sorted by max capacity desc then name A→Z.
 */
export async function getDefeatedProjects(): Promise<Facility[]> {
  const facilities = await loadFacilities();
  const frictionStatuses: CommunityReception[] = ["contested", "opposed", "litigation"];
  return facilities
    .filter(
      (f) =>
        f.status === "cancelled" &&
        !!f.community?.status &&
        frictionStatuses.includes(f.community.status)
    )
    .sort((a, b) => (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) || a.name.localeCompare(b.name));
}

// ============================================================
// Per-metro helpers (used by /metros pages)
// ============================================================

/**
 * Facilities located in a curated metro's counties, sorted by max capacity
 * (operational or planned) desc, then name A→Z. Matches on (state, county)
 * via `metroCountyKey` on both sides — county alone is not unique across
 * states (e.g. "Washington" county exists in OR, UT, and elsewhere) — and
 * normalizes away the live data's mixed `"X County"` / bare `"X"` county
 * strings (see `lib/metros.ts` doc comment). Facilities with no county on
 * record never match. Reads the shared `loadFacilities()` cache — no new
 * uncached per-request DB read (see that function's doc comment on the s51
 * ISR-write-blowout lesson). Unknown slug returns `[]`.
 */
export async function getFacilitiesByMetro(slug: string): Promise<Facility[]> {
  const metro = getMetroBySlug(slug);
  if (!metro) return [];
  const keys = new Set(metro.counties.map(([state, county]) => metroCountyKey(state, county)));
  const facilities = await loadFacilities();
  return facilities
    .filter(
      (f) => f.location.county != null && keys.has(metroCountyKey(f.location.state, f.location.county))
    )
    .sort((a, b) => (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) || a.name.localeCompare(b.name));
}

// ============================================================
// Per-operator helpers (used by operator landing pages)
// ============================================================

/** URL slug for an operator name, e.g. "Amazon Web Services" -> "amazon-web-services". */
export function operatorSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface OperatorIndex {
  /** Operator name -> that operator's facilities, pre-sorted by max MW desc, then name A→Z. */
  byOperator: Map<string, Facility[]>;
  /** operatorSlug(name) -> operator name, for case-insensitive reverse slug lookup. */
  slugToOperator: Map<string, string>;
}

/**
 * Operator index memoized per `loadFacilities()` result (keyed by array
 * identity in a WeakMap) so the per-operator helpers do O(1) map lookups
 * instead of re-scanning the whole list. Removes the O(operators × facilities)
 * blowup on the operators index page, the sitemap, and the exhaustive operator
 * tests. When the same array reference is reused (e.g. within one request via
 * the loadFacilities cache), the index is built once; otherwise it rebuilds
 * cheaply (a single O(facilities) grouping pass — no Zod re-validation now that
 * loadFromJson is memoized).
 */
const operatorIndexCache = new WeakMap<Facility[], OperatorIndex>();

function buildOperatorIndex(facilities: Facility[]): OperatorIndex {
  const cached = operatorIndexCache.get(facilities);
  if (cached) return cached;

  const byOperator = new Map<string, Facility[]>();
  for (const f of facilities) {
    const bucket = byOperator.get(f.operator);
    if (bucket) bucket.push(f);
    else byOperator.set(f.operator, [f]);
  }

  const slugToOperator = new Map<string, string>();
  for (const [name, bucket] of byOperator) {
    bucket.sort(
      (a, b) =>
        (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
        a.name.localeCompare(b.name)
    );
    slugToOperator.set(operatorSlug(name), name);
  }

  const index: OperatorIndex = { byOperator, slugToOperator };
  operatorIndexCache.set(facilities, index);
  return index;
}

/** Loads the facility list and returns its memoized operator index. */
async function getOperatorIndex(): Promise<OperatorIndex> {
  return buildOperatorIndex(await loadFacilities());
}

/**
 * Returns the operator name for a URL slug (case-insensitive), or undefined if
 * unknown. Backed by the memoized operator index — an O(1) map lookup rather
 * than rebuilding a slug -> name map from `getOperators()` on every call.
 */
export async function getOperatorBySlug(slug: string): Promise<string | undefined> {
  const { slugToOperator } = await getOperatorIndex();
  return slugToOperator.get(slug.toLowerCase());
}

/**
 * Returns all facilities operated by `name` (exact match), sorted by max
 * capacity (operational or planned) desc, then name A→Z (deterministic
 * tie-break). Backed by the memoized operator index — an O(1) map lookup
 * rather than a full-list filter+sort on every call.
 */
export async function getFacilitiesByOperator(name: string): Promise<Facility[]> {
  const { byOperator } = await getOperatorIndex();
  const bucket = byOperator.get(name);
  // Shallow copy so callers can't mutate the cached, pre-sorted bucket —
  // preserves the previous .filter().sort() contract of returning a fresh array.
  return bucket ? [...bucket] : [];
}

/** Aggregate summary of one operator's facilities. */
export interface OperatorSummary {
  name: string;
  count: number;
  /** Sum of capacityMw.operational across non-cancelled facilities. */
  operationalMw: number;
  /** Sum of capacityMw.planned across non-cancelled facilities. */
  plannedMw: number;
  byType: Record<FacilityType, number>;
  byStatus: Record<Status, number>;
  /** Distinct location.state values across the operator's facilities. */
  stateCount: number;
}

/**
 * Returns an aggregate summary for one operator, or null when the operator
 * has zero facilities. Mirrors `getStateSummary`'s capacity math (excludes
 * cancelled for operational/planned) and byType/byStatus seeding.
 */
export async function getOperatorSummary(name: string): Promise<OperatorSummary | null> {
  const { byOperator } = await getOperatorIndex();
  const operatorFacilities = byOperator.get(name) ?? [];
  const count = operatorFacilities.length;
  if (count === 0) {
    return null;
  }

  const active = operatorFacilities.filter((f) => f.status !== "cancelled");
  const operationalMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.operational ?? 0),
    0
  );
  const plannedMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.planned ?? 0),
    0
  );

  const byType = Object.fromEntries(
    FACILITY_TYPE_ORDER.map((k) => [k, 0])
  ) as Record<FacilityType, number>;
  const byStatus = Object.fromEntries(
    STATUS_ORDER.map((k) => [k, 0])
  ) as Record<Status, number>;
  const states = new Set<string>();

  for (const f of operatorFacilities) {
    byType[f.facilityType]++;
    byStatus[f.status]++;
    states.add(f.location.state);
  }

  return {
    name,
    count,
    operationalMw,
    plannedMw,
    byType,
    byStatus,
    stateCount: states.size,
  };
}

// ============================================================
// Activity feed (used by /activity and the homepage teaser)
// ============================================================

/** A single reverse-chronological activity entry — a facility create or update. */
export interface ActivityEntry {
  kind: "create" | "update";
  facilityId: string;
  facilityName: string;
  /** Short, non-diff label, e.g. "new facility added" or "facility updated". */
  label: string;
  timestamp: Date;
  /** Optional public contributor handle, when the change came from an attributed public submission. */
  attribution?: string;
}

/**
 * Returns a reverse-chronological feed of facility creates/updates, driven
 * entirely off `facility_history` — the single source of truth for change
 * events. History rows come from three paths: `lib/facility-write.ts` writes
 * exactly one row per admin-direct write or submission approval (see
 * `createFacility`/`updateFacility` and `approveSubmission` in
 * lib/submissions.ts, source `"admin-direct"` or a submission id);
 * `scripts/sync-to-neon.ts` (the `db:sync` CLI) writes one row per record a
 * maintainer publishes in a data wave, create OR update (source
 * `"maintainer-sync"`); and `scripts/seed.ts` (the bootstrap `db:seed` CLI)
 * writes a `create` row for each genuinely-new facility it inserts (source
 * `"db-seed"`) — so bulk-published facilities show up in the feed too.
 * Reading from history
 * instead of merging `facilitiesTable` (by `updatedAt`) with
 * `submissionsTable` (by `reviewedAt`) eliminates a double-entry bug: both of
 * those sources could capture the *same* create, showing it once as "new
 * facility added" and again as "facility updated" — and a direct admin
 * create was mislabeled "facility updated" entirely since
 * `facilitiesTable.updatedAt` is set on insert too.
 *
 * DB-only: the JSON fallback bundle has no history to sort on, so this
 * returns `[]` when `DATABASE_URL` is unset rather than throwing — the
 * public /activity page and homepage teaser both degrade to an empty section
 * instead of crashing. The query itself is also wrapped in a try/catch: a
 * live DB failure (unreachable, or over quota) degrades to `[]` the same
 * way, rather than throwing into those callers' bare `await` call sites.
 */
export async function getRecentActivity(limit = 50): Promise<ActivityEntry[]> {
  if (!hasDatabaseUrl()) {
    return [];
  }

  const db = getDb();

  try {
    // Single query, single source. The inner join naturally drops history rows
    // for facilities that have since been deleted (no dead links in the feed),
    // and the `where` keeps only create/update rows (delete events aren't
    // rendered in this feed).
    const rows = await db
      .select({
        facilityId: facilityHistoryTable.facilityId,
        facilityName: facilitiesTable.name,
        changeType: facilityHistoryTable.changeType,
        changedAt: facilityHistoryTable.changedAt,
        attribution: sql<string | null>`${submissionsTable.provenance} ->> 'attribution'`,
      })
      .from(facilityHistoryTable)
      .innerJoin(facilitiesTable, eq(facilityHistoryTable.facilityId, facilitiesTable.id))
      // Cast submissions.id (uuid) to text rather than casting source::uuid —
      // the latter would throw on "admin-direct" rows, which aren't valid
      // uuids and should simply not match. submissions.id is a unique PK, so
      // this LEFT JOIN can't fan out and never changes which rows return.
      .leftJoin(submissionsTable, sql`${submissionsTable.id}::text = ${facilityHistoryTable.source}`)
      .where(inArray(facilityHistoryTable.changeType, ["create", "update"]))
      .orderBy(desc(facilityHistoryTable.changedAt))
      .limit(limit);

    return rows.map((row) => ({
      kind: row.changeType === "create" ? "create" : "update",
      facilityId: row.facilityId,
      facilityName: row.facilityName,
      label: row.changeType === "create" ? "new facility added" : "facility updated",
      timestamp: row.changedAt,
      ...(row.attribution ? { attribution: row.attribution } : {}),
    }));
  } catch (err) {
    // A live query failure (DB unreachable or over-quota) degrades to an empty
    // feed rather than throwing into the homepage teaser / /activity page —
    // both render their existing empty state instead of the error boundary.
    console.warn("getRecentActivity: activity feed unavailable, degrading to empty", err);
    return [];
  }
}

// ============================================================
// Quarterly pipeline summary (used by the power/pipeline SEO lens)
// ============================================================

/** Aggregate counts of pipeline events (creates, status changes, cancellations) in the current calendar quarter. */
export interface QuarterlyPipelineSummary {
  newThisQuarter: number;
  cancelledThisQuarter: number;
  statusChangesThisQuarter: number;
}

/**
 * Returns `{ start, end }` (end exclusive) for the calendar quarter containing
 * `now`, computed in UTC so the result doesn't depend on the host machine's
 * local timezone. Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec.
 * `Date.UTC` naturally rolls a Q4 end into January of the following year.
 */
function getCurrentQuarterRange(now: Date = new Date()): { start: Date; end: Date } {
  const year = now.getUTCFullYear();
  const quarterIndex = Math.floor(now.getUTCMonth() / 3); // 0..3
  const start = new Date(Date.UTC(year, quarterIndex * 3, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, quarterIndex * 3 + 3, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * Returns quarter-scoped pipeline counts for the /power pipeline lens, driven
 * entirely off `facility_history` (never `submissions` — see CLAUDE.md's
 * write-staging invariant docs; a submission's approval is what produces the
 * history row this reads).
 *
 * `facility_history.change_type` is only `create | update | delete` (see
 * lib/db/schema.ts) — there is no distinct "cancelled" or "status-change"
 * change type, so those two counts can't be read off `change_type` alone.
 * Instead this inspects each `update` row's stored `diff` (`DiffEntry[]`,
 * computed once at write time by `lib/facility-write.ts` via
 * `computeDocDiff`, which diffs the full Facility doc at its top level):
 *   - `statusChangesThisQuarter` counts `update` rows whose diff contains a
 *     `key === "status"` entry — i.e. rows where the facility's `status`
 *     field itself changed, not just any field.
 *   - `cancelledThisQuarter` counts the distinct facilities among those whose
 *     status-diff entry's `after` value is `"cancelled"` — i.e. facilities
 *     that transitioned TO cancelled during the quarter. This is a real
 *     event count, not a "current status is cancelled" snapshot, so a later
 *     reversal within the same quarter doesn't retroactively invalidate it.
 * Both are exact, dataset-derived counts — no fabrication, no submissions read.
 *
 * DB-only: degrades to the all-zero object when `DATABASE_URL` is unset (the
 * JSON fallback bundle has no history to scope), and the query is wrapped in
 * try/catch so a live DB failure also degrades to zero rather than throwing
 * into the SEO lens page — same pattern as `getRecentActivity`.
 */
export async function getQuarterlyPipelineSummary(): Promise<QuarterlyPipelineSummary> {
  const empty: QuarterlyPipelineSummary = {
    newThisQuarter: 0,
    cancelledThisQuarter: 0,
    statusChangesThisQuarter: 0,
  };

  if (!hasDatabaseUrl()) {
    return empty;
  }

  const db = getDb();
  const { start, end } = getCurrentQuarterRange();

  try {
    const rows = await db
      .select({
        facilityId: facilityHistoryTable.facilityId,
        changeType: facilityHistoryTable.changeType,
        diff: facilityHistoryTable.diff,
      })
      .from(facilityHistoryTable)
      .where(
        and(
          inArray(facilityHistoryTable.changeType, ["create", "update"]),
          gte(facilityHistoryTable.changedAt, start),
          lt(facilityHistoryTable.changedAt, end)
        )
      );

    let newThisQuarter = 0;
    let statusChangesThisQuarter = 0;
    const cancelledFacilityIds = new Set<string>();

    for (const row of rows) {
      if (row.changeType === "create") {
        newThisQuarter++;
        continue;
      }

      const statusEntry = (row.diff as DiffEntry[]).find((entry) => entry.key === "status");
      if (!statusEntry) {
        continue;
      }

      statusChangesThisQuarter++;
      if (statusEntry.after === "cancelled") {
        cancelledFacilityIds.add(row.facilityId);
      }
    }

    return {
      newThisQuarter,
      cancelledThisQuarter: cancelledFacilityIds.size,
      statusChangesThisQuarter,
    };
  } catch (err) {
    // A live query failure (DB unreachable or over-quota) degrades to the
    // all-zero summary rather than throwing into the pipeline lens page.
    console.warn(
      "getQuarterlyPipelineSummary: pipeline summary unavailable, degrading to zero",
      err
    );
    return empty;
  }
}
