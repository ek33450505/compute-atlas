import { STATUS_ORDER } from "@/lib/status";
import { getDisplayedCapacityMw } from "@/lib/format";
import { getFacilityTypeMeta } from "@/lib/facility-type";
import type { TableRow } from "@/lib/facility-slim";

/** Column ids the /table can sort by. Mirrors the column ids in components/table/facility-table.tsx. */
export const SORT_COLUMNS = [
  "name",
  "operator",
  "status",
  "facilityType",
  "aiClassification",
  "location",
  "capacity",
  "confidence",
  "lastUpdated",
] as const;

export type SortColumn = (typeof SORT_COLUMNS)[number];
export type SortDir = "asc" | "desc";

/** Status order (operational first, cancelled last). */
export function compareStatus(a: TableRow, b: TableRow): number {
  return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
}

/** Displayed capacity (operational, else planned) ascending; facilities with no capacity data sort last. */
export function compareCapacity(a: TableRow, b: TableRow): number {
  const x = getDisplayedCapacityMw(a);
  const y = getDisplayedCapacityMw(b);
  if (x === undefined && y === undefined) return 0;
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  return x - y;
}

function aiClass(r: TableRow): string | undefined {
  return r.facilityType === "data_center" || r.facilityType === "crypto_mining"
    ? r.aiClassification
    : undefined;
}

function compareStrings(x: string | undefined, y: string | undefined): number {
  if (x === undefined && y === undefined) return 0;
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  return x.localeCompare(y);
}

/** Ascending comparison for one column. Rows missing the value return "after" regardless of direction (see compareRows). */
function primary(col: SortColumn, a: TableRow, b: TableRow): number {
  switch (col) {
    case "name":
      return a.name.localeCompare(b.name);
    case "operator":
      return a.operator.localeCompare(b.operator);
    case "status":
      return compareStatus(a, b);
    case "facilityType":
      return getFacilityTypeMeta(a.facilityType).label.localeCompare(
        getFacilityTypeMeta(b.facilityType).label
      );
    case "aiClassification":
      return compareStrings(aiClass(a), aiClass(b));
    case "location":
      return a.location.state.localeCompare(b.location.state);
    case "capacity":
      return compareCapacity(a, b);
    case "confidence":
      return a.confidence.localeCompare(b.confidence);
    case "lastUpdated":
      return a.lastUpdated.localeCompare(b.lastUpdated);
  }
}

function isMissing(col: SortColumn, r: TableRow): boolean {
  if (col === "capacity") return getDisplayedCapacityMw(r) === undefined;
  if (col === "aiClassification") return aiClass(r) === undefined;
  return false;
}

/**
 * Comparator for `Array.prototype.sort`. Missing values (no capacity / no AI
 * class) sort last in BOTH directions. Ties break by name then id, never
 * reversed by `dir`, so pagination over a sorted list is stable.
 */
export function compareRows(col: SortColumn, dir: SortDir): (a: TableRow, b: TableRow) => number {
  return (a, b) => {
    const am = isMissing(col, a);
    const bm = isMissing(col, b);
    if (am !== bm) return am ? 1 : -1;
    const c = am ? 0 : primary(col, a, b);
    if (c !== 0) return dir === "desc" ? -c : c;
    return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}
