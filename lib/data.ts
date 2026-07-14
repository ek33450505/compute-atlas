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
import { desc, eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/lib/db/client";
import { facilitiesTable, submissionsTable } from "@/lib/db/schema";
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
 * Cached, deterministically-ordered facility loader tagged `"facilities"`
 * so a future `revalidateTag("facilities")` (Phase 3) can bust it.
 *
 * `unstable_cache` requires the Next.js request-scoped cache context, which
 * is absent under vitest — detect that environment and degrade to the
 * uncached loader directly so the 536-test suite (which runs with no
 * DATABASE_URL, exercising the JSON fallback) stays green.
 */
export const loadFacilities: () => Promise<Facility[]> = process.env.VITEST
  ? loadFacilitiesUncached
  : unstable_cache(loadFacilitiesUncached, ["facilities"], { tags: ["facilities"] });

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
 * Returns an aggregate summary for one state, or null when the state has
 * zero facilities. Mirrors `getStats`' capacity math (excludes cancelled for
 * operational/planned) and `getTopOperators`' tie-break for `topOperators`.
 */
export async function getStateSummary(code: string): Promise<StateSummary | null> {
  const facilities = await loadFacilities();
  const upper = code.toUpperCase();
  const stateFacilities = facilities.filter((f) => f.location.state === upper);
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
 */
export async function getPoweredCampuses(facility: Facility): Promise<Facility[]> {
  if (facility.facilityType !== "power_generation") return [];
  const ids = facility.generation?.poweredFacilityIds ?? [];
  const resolved = await Promise.all(ids.map((id) => getFacilityById(id)));
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
 */
export async function getPoweredByGenerators(facility: Facility): Promise<PowerGenerationFacility[]> {
  const generation = await getPowerGenerationFacilities();
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

/** A single reverse-chronological activity entry — either an updated facility or an approved contribution. */
export interface ActivityEntry {
  kind: "facility_updated" | "submission_approved";
  facilityId: string;
  facilityName: string;
  /** Short, non-diff label, e.g. "status updated" or "new facility added". */
  label: string;
  timestamp: Date;
}

/**
 * Returns recently-updated facilities and recently-approved submissions,
 * merged into a single reverse-chronological feed (most recent first).
 *
 * DB-only: the JSON fallback bundle has no `updatedAt`/`reviewedAt` history
 * to sort on, so this returns `[]` when `DATABASE_URL` is unset rather than
 * throwing — the public /activity page and homepage teaser both degrade to
 * an empty section instead of crashing.
 */
export async function getRecentActivity(limit = 50): Promise<ActivityEntry[]> {
  if (!hasDatabaseUrl()) {
    return [];
  }

  const db = getDb();

  // Fetch 2x the final limit from each source before merging. Each source is
  // ordered independently, so an equal per-source LIMIT can drop genuinely
  // recent entries: e.g. requesting 50 with 30 stale facility updates ahead
  // of 20 fresh submissions in wall-clock time still fetches only the top 50
  // of each, and the post-merge sort can discard newer facility rows that
  // never made it past their own source's cutoff. Over-fetching guarantees
  // the merge always has enough candidates from both sources to find the
  // true top-N once sorted together.
  const [updatedFacilities, approvedSubmissions] = await Promise.all([
    db
      .select()
      .from(facilitiesTable)
      .orderBy(desc(facilitiesTable.updatedAt))
      .limit(2 * limit),
    db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.status, "approved"))
      .orderBy(desc(submissionsTable.reviewedAt))
      .limit(2 * limit),
  ]);

  const facilityEntries: ActivityEntry[] = updatedFacilities.map((row) => ({
    kind: "facility_updated",
    facilityId: row.id,
    facilityName: row.name,
    label: "facility updated",
    timestamp: row.updatedAt,
  }));

  const submissionEntries: ActivityEntry[] = approvedSubmissions
    .filter((row) => row.reviewedAt !== null)
    .map((row) => {
      const payload = row.payload as Record<string, unknown>;
      const facilityId = row.targetFacilityId ?? String(payload.id ?? "");
      const facilityName =
        typeof payload.name === "string" ? payload.name : facilityId || "Unknown facility";
      return {
        kind: "submission_approved",
        facilityId,
        facilityName,
        label: row.kind === "create" ? "new facility added" : "contribution approved",
        // Non-null assertion is safe: filtered above.
        timestamp: row.reviewedAt!,
      };
    });

  return [...facilityEntries, ...submissionEntries]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}
