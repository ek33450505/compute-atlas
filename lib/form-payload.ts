/**
 * Shared payload-building helpers for the public contribute form
 * (`components/contribute/contribute-facility-form.tsx`) and the admin
 * facility form (`app/admin/facilities/facility-form.tsx`).
 */

/**
 * Parses a numeric `<input>` string into `number | undefined`.
 * Empty/whitespace-only input becomes `undefined` (never `NaN` or `0`).
 */
export function numOrUndefined(v: string): number | undefined {
  return v.trim() === "" ? undefined : Number(v);
}
