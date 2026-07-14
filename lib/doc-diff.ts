/**
 * Shared shallow top-level diff utility. Computes a stored/computed diff at
 * write time (Phase 5a) rather than persisting two full before/after doc
 * columns — `facility_history.diff` stores the array this returns.
 *
 * Generalizes the shallow diff already inline in
 * `app/admin/submissions/submission-detail.tsx`'s `UpdateDiff` component:
 * `computeDocDiff(current, {...current, ...patch})` reproduces that
 * component's exact current behavior (spreading `patch` over `current` then
 * diffing against `current` only ever flags `patch`'s own changed keys).
 */

export interface DiffEntry {
  key: string;
  before: unknown;
  after: unknown;
}

/**
 * Unions the keys of `before` and `after` (a `null` side is treated as `{}`,
 * covering create/delete), coerces missing/undefined values to `null` on
 * both sides so the diff survives jsonb round-tripping (plain
 * `JSON.stringify` silently drops object properties whose value is
 * `undefined`), and returns one entry per key whose JSON-stringified value
 * differs.
 */
export function computeDocDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): DiffEntry[] {
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const entries: DiffEntry[] = [];
  for (const key of keys) {
    const beforeVal = b[key] ?? null;
    const afterVal = a[key] ?? null;
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      entries.push({ key, before: beforeVal, after: afterVal });
    }
  }
  return entries;
}
