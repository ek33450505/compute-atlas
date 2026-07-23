import type { z } from "zod";
import { unstable_cache } from "next/cache";
import {
  facilitiesSchema,
  type Facility,
  type PowerGenerationFacility,
  aiClassificationEnum,
  confidenceEnum,
} from "@/lib/schema";
import { STATUS_ORDER, type Status } from "@/lib/status";
import { FACILITY_TYPE_ORDER, type FacilityType } from "@/lib/facility-type";
import { COMMUNITY_RECEPTION_ORDER, type CommunityReception } from "@/lib/community";
import { getFacilityMaxMw } from "@/lib/format";
import facilitiesRaw from "@/data/facilities.json";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/lib/db/client";
import { facilitiesTable, facilityHistoryTable } from "@/lib/db/schema";
import { rowToFacility } from "@/lib/db/serialize";

/** Parses and validates the bundled JSON fallback. Throws loudly on bad data. */
function loadFromJson(): Facility[] {
  const parsed = facilitiesSchema.safeParse(facilitiesRaw);
  if (!parsed.success) {
    throw new Error(
      "Invalid facilities data:\n" +
        parsed.error.issues
          .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
          .join("\n")
    );
  }
  return parsed.data;
}

/**
 * Loads the full facility set from Neon when `DATABASE_URL` is configured,
 * falling back to the bundled JSON otherwise. DB-sourced docs are trusted
 * as-is (validated at write time via `docToRow`/the Facility schema) — no
 * re-parse on read. Both paths sort by `id` so the DB and fallback produce
 * byte-identical ordering.
 */
async function loadFacilitiesUncached(): Promise<Facility[]> {
  const list = hasDatabaseUrl()
    ? (await getDb().select().from(facilitiesTable)).map(rowToFacility)
    : loadFromJson();
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
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
 * DATABASE_URL, exercising the JSON fallback) stays green.
 */
export const loadFacilities: () => Promise<Facility[]> = process.env.VITEST
  ? loadFacilitiesUncached
  : unstable_cache(loadFacilitiesUncached, ["facilities"], {
      tags: ["facilities"],
      revalidate: 3600,
    });

/**
 * 24h-revalidate view of the facility list for the GLOBAL ⌘K search index ONLY.
 * <SiteHeader> renders it in the root layout on every route, so this read's
 * revalidate becomes the site-wide ISR floor — deliberately long (86400s) so it
 * does NOT pin every page to a 1h cycle. Aggregate pages read loadFacilities
 * (1h) directly and float above this floor; detail/state pages read scoped
 * tag-only caches and floor here at 24h. Same "facilities" tag (inert — nothing
 * calls revalidateTag("facilities") anymore).
 */
export const loadFacilitiesForSearch: () => Promise<Facility[]> = process.env.VITEST
  ? loadFacilitiesUncached
  : unstable_cache(loadFacilitiesUncached, ["facilities-search"], {
      tags: ["facilities"],
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

/** Uncached direct-row fetch backing `getFacilityByIdCached`. */
async function fetchFacilityByIdUncached(id: string): Promise<Facility | undefined> {
  if (hasDatabaseUrl()) {
    const rows = await getDb().select().from(facilitiesTable).where(eq(facilitiesTable.id, id));
    return rows[0] ? rowToFacility(rows[0]) : undefined;
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

/** Uncached direct-filtered fetch backing `getFacilitiesByStateCached`. */
async function fetchFacilitiesByStateUncached(code: string): Promise<Facility[]> {
  const upper = code.toUpperCase();
  const list = hasDatabaseUrl()
    ? (await getDb().select().from(facilitiesTable)).map(rowToFacility)
    : loadFromJson();
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

/** Uncached full power_generation-facility load backing `loadPowerGenerationCached`. */
async function loadPowerGenerationUncached(): Promise<PowerGenerationFacility[]> {
  const list = hasDatabaseUrl()
    ? (await getDb().select().from(facilitiesTable)).map(rowToFacility)
    : loadFromJson();
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
// Water use helpers (used by /stats Water use section)
// ============================================================

export interface WaterUsage {
  /** Non-cancelled facilities disclosing a positive daily water figure. */
  reportingCount: number;
  /** Sum of reportedMgd (million gallons/day) across those facilities. */
  totalMgd: number;
}

/**
 * Returns the count and total daily water usage (MGD) across non-cancelled
 * facilities that disclose a positive `water.reportedMgd` figure.
 * This is a reported floor — most facilities do not publish a daily water figure.
 */
export async function getWaterUsage(): Promise<WaterUsage> {
  const facilities = await loadFacilities();
  const reporting = facilities.filter(
    (f) =>
      f.status !== "cancelled" &&
      typeof f.water?.reportedMgd === "number" &&
      f.water.reportedMgd > 0
  );
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
// Community-friction helpers (used by /opposition)
// ============================================================

/** Facilities whose community.status matches `status`, sorted by max capacity desc then name A→Z. */
export async function getFacilitiesByCommunityStatus(status: CommunityReception): Promise<Facility[]> {
  const facilities = await loadFacilities();
  return facilities
    .filter((f) => f.community?.status === status)
    .sort((a, b) => (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) || a.name.localeCompare(b.name));
}

// ============================================================
// Per-operator helpers (used by operator landing pages)
// ============================================================

/** URL slug for an operator name, e.g. "Amazon Web Services" -> "amazon-web-services". */
export function operatorSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Returns the operator name for a URL slug (case-insensitive), or undefined if
 * unknown. The slug -> name map is built lazily from the async facility list
 * (it can no longer be precomputed at module scope now that the source is
 * async) — recomputed per call rather than cached, since `getOperators()`
 * already sits behind `loadFacilities`'s own cache.
 */
export async function getOperatorBySlug(slug: string): Promise<string | undefined> {
  const operators = await getOperators();
  const slugToOperator: Record<string, string> = Object.fromEntries(
    operators.map((name) => [operatorSlug(name), name])
  );
  return slugToOperator[slug.toLowerCase()];
}

/**
 * Returns all facilities operated by `name` (exact match), sorted by max
 * capacity (operational or planned) desc, then name A→Z (deterministic
 * tie-break).
 */
export async function getFacilitiesByOperator(name: string): Promise<Facility[]> {
  const facilities = await loadFacilities();
  return facilities
    .filter((f) => f.operator === name)
    .sort(
      (a, b) =>
        (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
        a.name.localeCompare(b.name)
    );
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
  const facilities = await loadFacilities();
  const operatorFacilities = facilities.filter((f) => f.operator === name);
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
}

/**
 * Returns a reverse-chronological feed of facility creates/updates, driven
 * entirely off `facility_history` — the single source of truth for change
 * events. Every create/update/delete, whether an admin-direct write or a
 * submission approval, goes through `lib/facility-write.ts` and writes
 * exactly one history row (see `createFacility`/`updateFacility` and
 * `approveSubmission` in lib/submissions.ts). Reading from history instead of
 * merging `facilitiesTable` (by `updatedAt`) with `submissionsTable` (by
 * `reviewedAt`) eliminates a double-entry bug: both of those sources could
 * capture the *same* create, showing it once as "new facility added" and
 * again as "facility updated" — and a direct admin create was mislabeled
 * "facility updated" entirely since `facilitiesTable.updatedAt` is set on
 * insert too.
 *
 * DB-only: the JSON fallback bundle has no history to sort on, so this
 * returns `[]` when `DATABASE_URL` is unset rather than throwing — the
 * public /activity page and homepage teaser both degrade to an empty section
 * instead of crashing.
 */
export async function getRecentActivity(limit = 50): Promise<ActivityEntry[]> {
  if (!hasDatabaseUrl()) {
    return [];
  }

  const db = getDb();

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
    })
    .from(facilityHistoryTable)
    .innerJoin(facilitiesTable, eq(facilityHistoryTable.facilityId, facilitiesTable.id))
    .where(inArray(facilityHistoryTable.changeType, ["create", "update"]))
    .orderBy(desc(facilityHistoryTable.changedAt))
    .limit(limit);

  return rows.map((row) => ({
    kind: row.changeType === "create" ? "create" : "update",
    facilityId: row.facilityId,
    facilityName: row.facilityName,
    label: row.changeType === "create" ? "new facility added" : "facility updated",
    timestamp: row.changedAt,
  }));
}
