import { CODEBOOK_ENTRIES } from "@/lib/dataset-codebook";
import { CSV_COLUMNS, csvCells } from "@/lib/dataset-csv";
import type { Facility } from "@/lib/schema";

/**
 * Per-field coverage of an edition: how many records carry a value. Pure, no DB or fs.
 *
 * A CSV column's name is also its codebook path (the codebook's CSV rows are written in CSV order from the
 * same names), so `applicable` looks the column up by name in `CODEBOOK_ENTRIES`. A column with no codebook
 * entry falls back to every record; that is unreachable for CSV columns, because lib/dataset-codebook.test.ts
 * asserts the codebook's CSV paths equal `CSV_COLUMNS` exactly.
 */

export interface CoverageRow {
  key: string;
  filled: number;
  applicable: number;
}

const JOIN_KEYS = ["countyFips", "tractGeoid", "egridSubregion", "balancingAuthority"] as const;

/**
 * Join keys that exist only for records with a prerequisite field: balancingAuthority is derived from
 * `energy.utilityEiaId`, so its denominator is the records carrying one. (`isoRto` is not reported: it exists
 * only for RTO balancing authorities, so a fill rate against any denominator would read as a gap.)
 */
const JOIN_KEY_APPLICABLE: Partial<Record<(typeof JOIN_KEYS)[number], (f: Facility) => boolean>> = {
  balancingAuthority: (f) => f.energy?.utilityEiaId !== undefined,
};

const APPLIES_TO = new Map(CODEBOOK_ENTRIES.map((e) => [e.path, e.appliesTo] as const));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One row per CSV column in order, then (when `siting` is given) one per join key. `siting` is untrusted
 * shape: only entries for ids present in `facilities` are read, and only a non-empty string counts.
 */
export function computeCoverage(
  facilities: readonly Facility[],
  siting: Record<string, unknown> | null,
): CoverageRow[] {
  const filled = CSV_COLUMNS.map(() => 0);
  const applicable = CSV_COLUMNS.map((key) => {
    const appliesTo = APPLIES_TO.get(key);
    return !appliesTo || appliesTo === "all" ? facilities.length : facilities.filter((f) => appliesTo.includes(f.facilityType)).length;
  });
  for (const f of facilities) {
    csvCells(f).forEach((cell, i) => {
      if (cell !== "") filled[i]++;
    });
  }
  const rows: CoverageRow[] = CSV_COLUMNS.map((key, i) => ({ key, filled: filled[i], applicable: applicable[i] }));

  if (siting) {
    for (const key of JOIN_KEYS) {
      let count = 0;
      for (const f of facilities) {
        const entry = Object.hasOwn(siting, f.id) ? siting[f.id] : undefined;
        const joinKeys = isRecord(entry) ? entry.joinKeys : undefined;
        const value = isRecord(joinKeys) ? joinKeys[key] : undefined;
        if (typeof value === "string" && value !== "") count++;
      }
      const applies = JOIN_KEY_APPLICABLE[key];
      rows.push({ key: `joinKeys.${key}`, filled: count, applicable: applies ? facilities.filter(applies).length : facilities.length });
    }
  }
  return rows;
}

/** key -> filled, the shape stored with the edition row. */
export function coverageMap(rows: readonly CoverageRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.key, r.filled]));
}

/** Adds the change since the previous edition's stored map; `null` where it has no usable count for the key. */
export function withDeltas(
  rows: readonly CoverageRow[],
  prev: unknown,
): Array<CoverageRow & { delta: number | null }> {
  const stored = isRecord(prev) ? prev : {};
  return rows.map((r) => {
    const before = Object.hasOwn(stored, r.key) ? stored[r.key] : undefined;
    const usable = typeof before === "number" && Number.isInteger(before) && before >= 0;
    return { ...r, delta: usable ? r.filled - before : null };
  });
}
