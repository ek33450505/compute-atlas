/**
 * The NHD-debt ratchet's decision, as a pure function: shared by
 * siting-context.test.ts (synthetic inputs, default run) and
 * siting-context.dataset.test.ts (the real ledger and dataset), so the two can
 * never apply different comparisons.
 *
 * "grew": more debt than the ceiling records. "paid_down": less (the ceiling is
 * stale and silently re-permits regrowth). "ok": exactly equal.
 */
export type RatchetVerdict = "ok" | "grew" | "paid_down";

export function ratchetVerdict(count: number, ceiling: number): RatchetVerdict {
  if (count > ceiling) return "grew";
  if (count < ceiling) return "paid_down";
  return "ok";
}
