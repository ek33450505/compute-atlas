import type { KeyedRow, KeyedStore } from "../lib/closed-data-store";

/** In-memory KeyedStore for script tests; the faults model a write that does not land cleanly. */
export function fakeStore(
  initial: Record<string, unknown> = {},
  faults: { dropKey?: string; corruptKey?: string } = {},
): KeyedStore & { rows: Map<string, unknown>; upsertCalls: KeyedRow[][] } {
  const rows = new Map<string, unknown>(Object.entries(initial));
  const upsertCalls: KeyedRow[][] = [];
  return {
    rows,
    upsertCalls,
    async readAll() {
      return new Map(rows);
    },
    async upsert(batch) {
      upsertCalls.push(batch);
      for (const { key, data, onConflict } of batch) {
        if (key === faults.dropKey) continue;
        if (onConflict === "nothing" && rows.has(key)) continue;
        rows.set(key, key === faults.corruptKey ? { corrupted: true } : data);
      }
    },
  };
}
