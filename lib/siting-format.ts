/**
 * Shared distance-cue formatters — used by both the on-page Siting context
 * section (components/facility/siting-context.tsx) and the map popup's
 * compact one-line summary (components/map/facility-popup.tsx).
 *
 * Both call sites share the "≈ X mi — Y" / "On …" phrasing. The popup's
 * zero-distance transmission phrasing is shorter ("On a 500 kV line" vs.
 * "On a 500 kV transmission line") since it's a one-line summary, not a
 * labeled definition list — pass `{ compact: true }` to get that shorter
 * form; the default matches the on-page wording.
 */
export function formatNearestWater(name: string, distanceMi: number): string {
  if (distanceMi === 0) return `On ${name}`;
  return `≈ ${distanceMi.toFixed(1)} mi — ${name}`;
}

export function formatNearestTransmission(
  voltageKv: number,
  distanceMi: number,
  options?: { compact?: boolean },
): string {
  if (distanceMi === 0) {
    return options?.compact
      ? `On a ${voltageKv} kV line`
      : `On a ${voltageKv} kV transmission line`;
  }
  return `≈ ${distanceMi.toFixed(1)} mi — ${voltageKv} kV line`;
}
