import { STATUS_ORDER, type Status } from "@/lib/status";
import type { Facility } from "@/lib/schema";
import { getFacilityMaxMw } from "@/lib/format";

export interface FacilityFilters {
  statuses?: Status[];
  states?: string[];
  operators?: string[];
  /** Minimum MW (inclusive). Facilities with no capacity data are excluded when minMw > 0. */
  minMw?: number;
  /** Case-insensitive substring match over name, operator, city, and state. */
  query?: string;
}

/**
 * Returns facilities that match ALL provided filters.
 * Empty or omitted filter arrays / undefined values → no constraint applied.
 */
export function filterFacilities(
  facilities: Facility[],
  f: FacilityFilters
): Facility[] {
  return facilities.filter((facility) => {
    // Status: include if filter is empty/undefined OR facility.status is in the list
    if (f.statuses && f.statuses.length > 0) {
      if (!f.statuses.includes(facility.status)) return false;
    }

    // States: same membership pattern
    if (f.states && f.states.length > 0) {
      if (!f.states.includes(facility.location.state)) return false;
    }

    // Operators: same membership pattern
    if (f.operators && f.operators.length > 0) {
      if (!f.operators.includes(facility.operator)) return false;
    }

    // MinMw: exclude facilities with no capacity when minMw > 0
    if (f.minMw !== undefined && f.minMw > 0) {
      const maxMw = getFacilityMaxMw(facility);
      if (maxMw === undefined || maxMw < f.minMw) return false;
    }

    // Query: case-insensitive substring over name + operator + city + state
    if (f.query && f.query.trim().length > 0) {
      const q = f.query.trim().toLowerCase();
      const searchable = [
        facility.name,
        facility.operator,
        facility.location.city ?? "",
        facility.location.state,
      ]
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(q)) return false;
    }

    return true;
  });
}

export interface FilterOptions {
  /** Only statuses present in the dataset, ordered by STATUS_ORDER. */
  statuses: Status[];
  /** Unique state codes, sorted A→Z. */
  states: string[];
  /** Unique operator names, sorted A→Z. */
  operators: string[];
  /** Highest MW value across all facilities (0 if none have capacity). */
  maxMw: number;
}

/**
 * Derives available filter values from the given facilities array.
 */
export function getFilterOptions(facilities: Facility[]): FilterOptions {
  const presentStatuses = STATUS_ORDER.filter((s) =>
    facilities.some((f) => f.status === s)
  );

  const states = [...new Set(facilities.map((f) => f.location.state))].sort();
  const operators = [...new Set(facilities.map((f) => f.operator))].sort();

  const mwValues = facilities
    .map((f) => getFacilityMaxMw(f))
    .filter((mw): mw is number => mw !== undefined);
  const maxMw = mwValues.length > 0 ? Math.max(...mwValues) : 0;

  return { statuses: presentStatuses, states, operators, maxMw };
}
