/**
 * Order-insensitive canonical JSON comparison — the shared definition of
 * "these two facility docs are the same record".
 *
 * `data/facilities.json` and the Neon `doc` jsonb column hold the same
 * objects but not necessarily the same key ORDER: Postgres `jsonb` does not
 * preserve insertion order, and a hand-edited JSON splice can reorder keys
 * without changing a single value. A plain `JSON.stringify` compare flags
 * all of that as a difference. Canonicalizing first — recursively sorting
 * object keys — means only real value changes count.
 *
 * ARRAY order is deliberately preserved: `sources`, `statusHistory` and the
 * `sourceIndex` references that point into `sources` are all meaningfully
 * ordered, so a reordered array IS a change.
 *
 * `scripts/check-neon-drift.ts` (which reports drift) and
 * `scripts/sync-to-neon.ts` (which repairs it) MUST agree on this, or the
 * drift checker would flag rows the sync tool considers identical — forever.
 * That shared invariant is why this lives in `lib/` rather than inline in
 * either script.
 */

/** Recursively sorts object keys; leaves arrays and primitives alone. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce((acc: Record<string, unknown>, key) => ((acc[key] = canonicalize(obj[key])), acc), {});
  }
  return value;
}

/** `JSON.stringify` over the canonical form — the comparable string for a doc. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * The sorted set of TOP-LEVEL keys whose canonical values differ. Matches the
 * granularity of `facility_history.diff` (`lib/doc-diff.ts`), which is also
 * shallow — a change anywhere inside `location` reports as `location`.
 */
export function changedTopLevelKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (canonicalStringify(a[key]) !== canonicalStringify(b[key])) changed.push(key);
  }
  return changed.sort();
}
