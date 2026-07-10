import type { z } from "zod";
import { facilitiesSchema, type Facility, aiClassificationEnum, confidenceEnum } from "@/lib/schema";
import { STATUS_ORDER, type Status } from "@/lib/status";
import facilitiesRaw from "@/data/facilities.json";

// Validate at module load time so `next build` fails loudly on bad data.
const parseResult = facilitiesSchema.safeParse(facilitiesRaw);
if (!parseResult.success) {
  throw new Error(
    "Invalid facilities data:\n" +
      parseResult.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")
  );
}

export const facilities: Facility[] = parseResult.data;

export function getAllFacilities(): Facility[] {
  return facilities;
}

export function getFacilityById(id: string): Facility | undefined {
  return facilities.find((f) => f.id === id);
}

/** Returns unique 2-letter state codes, sorted A→Z. */
export function getStates(): string[] {
  return [...new Set(facilities.map((f) => f.location.state))].sort();
}

/** Returns unique operator names, sorted A→Z. */
export function getOperators(): string[] {
  return [...new Set(facilities.map((f) => f.operator))].sort();
}

/** Returns a count per status for all facilities (all 5 statuses always present). */
export function getStatusCounts(): Record<Status, number> {
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
export function getStats(): {
  count: number;
  states: number;
  operationalMw: number;
  plannedMw: number;
} {
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
  return { count, states, operationalMw, plannedMw };
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
export function getCivicCoverage(): CivicCoverage {
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
export function getTopStates(n = 10): { state: string; count: number }[] {
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
export function getTopOperators(n = 10): { operator: string; count: number }[] {
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
export function getAiClassificationCounts(): Record<
  z.infer<typeof aiClassificationEnum>,
  number
> {
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
export function getConfidenceCounts(): Record<Facility["confidence"], number> {
  const counts = Object.fromEntries(
    confidenceEnum.options.map((k) => [k, 0])
  ) as Record<Facility["confidence"], number>;
  for (const f of facilities) {
    counts[f.confidence]++;
  }
  return counts;
}

/** Returns the top-N facilities sorted by highest capacity (operational or planned). */
export function getNotableFacilities(n = 6): Facility[] {
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
export function getWaterUsage(): WaterUsage {
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
export function getCoolingTypeCounts(): Record<CoolingType, number> {
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
