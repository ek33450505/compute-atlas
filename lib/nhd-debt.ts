// NHD backfill debt: the facilities in data/siting-context.json that still lack
// `nearestWater` and that a successful `npm run build:mapdata` could fill.
//
// Pure helpers only (no fs, no JSON imports) so the ratchet test in
// lib/siting-context.test.ts, scripts/update-nhd-debt.ts and the automation that
// calls that script all share one definition of "debt". Callers inject the data.
// The recorded ceiling lives in data/nhd-backfill-debt.json.

// NHD, HIFLD, WRI Aqueduct and the USGS principal aquifers are all CONUS-only,
// so these jurisdictions can never match and are not debt.
export const NON_CONUS: ReadonlySet<string> = new Set(["HI", "AK", "GU", "MP", "PR", "VI"]);

// `FacilityStateRow` is the minimal facility shape the debt count needs, and
// `SitingEntryRow` the minimal siting-context entry shape; both are structural
// so the real imported JSON and synthetic test fixtures satisfy them alike.
export type FacilityStateRow = { id: string; location: { state: string } };
export type SitingEntryRow = { nearestWater?: unknown };
export type NhdDebtOffender = { id: string; state: string };

export function stateById(facilities: FacilityStateRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const facility of facilities) {
    map.set(facility.id, facility.location.state);
  }
  return map;
}

export function missingNearestWaterOffenders(
  facilities: FacilityStateRow[],
  sitingContext: Record<string, SitingEntryRow>,
): NhdDebtOffender[] {
  const stateMap = stateById(facilities);
  const offenders: NhdDebtOffender[] = [];

  for (const [id, entry] of Object.entries(sitingContext)) {
    if (entry.nearestWater !== undefined) continue; // has it - not debt

    // An ORPHAN (siting entry with no facility) is not debt: it has no page, so
    // it renders no partial panel. Retiring a facility takes a raw Neon delete
    // that deliberately leaves the entry behind (see CLAUDE.md), which is why
    // the coverage test in lib/siting-context.test.ts asserts forward coverage
    // only. Counting orphans would make a pure-retirement wave churn the ceiling
    // for the wrong reason.
    const state = stateMap.get(id);
    if (state === undefined) continue;

    if (NON_CONUS.has(state)) continue; // CONUS-only datasets can't match here

    offenders.push({ id, state });
  }

  return offenders;
}

export function perStateBreakdown(offenders: NhdDebtOffender[]): string {
  const counts = new Map<string, number>();
  for (const { state } of offenders) {
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([state, count]) => `${state}: ${count}`)
    .join(", ");
}

// The recorded ceiling (data/nhd-backfill-debt.json). A DEBT ratchet, not a
// target: the ratchet test fails if the live count is above it (unrecorded
// growth) or below it (a silent paydown), so the file must always equal the count.
export type NhdDebtLedger = { ceiling: number; asOf: string; note: string };

export const DEFAULT_LEDGER_NOTE = "Updated by scripts/update-nhd-debt.ts";

// Validates a parsed ledger. Throws on anything whose `ceiling` is not a
// non-negative integer, because a string or a fraction would silently coerce
// inside the ratchet comparisons instead of failing.
export function parseLedger(raw: unknown): NhdDebtLedger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("data/nhd-backfill-debt.json is malformed: expected a JSON object");
  }
  const { ceiling, asOf, note } = raw as Record<string, unknown>;
  if (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling < 0) {
    throw new Error(
      `data/nhd-backfill-debt.json is malformed: "ceiling" must be a non-negative integer, got ${JSON.stringify(ceiling)}`,
    );
  }
  return {
    ceiling,
    asOf: typeof asOf === "string" ? asOf : "",
    note: typeof note === "string" ? note : "",
  };
}

export type LedgerPlan = {
  /** The recorded ceiling, or null when the ledger file does not exist yet. */
  previous: number | null;
  /** The ledger to write, or null when nothing should be written. */
  next: NhdDebtLedger | null;
};

// Decides whether the ledger needs rewriting. `ledger` is the parsed file, or
// undefined when it does not exist (ceiling unknown, so write it). An unchanged
// count writes nothing, so `asOf` only moves when the ceiling does. A malformed
// ledger throws rather than being overwritten: silently replacing it would hide
// whatever corrupted it.
export function planLedgerUpdate(
  count: number,
  ledger: unknown,
  note: string | undefined,
  today: string,
): LedgerPlan {
  if (ledger === undefined) {
    return { previous: null, next: { ceiling: count, asOf: today, note: note ?? DEFAULT_LEDGER_NOTE } };
  }
  const { ceiling } = parseLedger(ledger);
  if (ceiling === count) return { previous: ceiling, next: null };
  return {
    previous: ceiling,
    next: { ceiling: count, asOf: today, note: note ?? DEFAULT_LEDGER_NOTE },
  };
}
