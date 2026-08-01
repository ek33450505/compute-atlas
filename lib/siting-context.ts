import sitingContextRaw from "@/data/siting-context.json";

/**
 * Nearest named surface-water feature to a facility, straight-line distance.
 * Source: USGS National Hydrography Dataset.
 */
export interface NearestWater {
  name: string;
  kind: "river" | "lake";
  distanceMi: number;
}

/**
 * Nearest high-voltage (>=230kV) electric transmission line to a facility,
 * straight-line distance. Source: HIFLD. This is a siting signal, not a
 * stated interconnection.
 */
export interface NearestTransmission {
  voltageKv: number;
  distanceMi: number;
}

/**
 * Pre-computed siting-context entry for one facility. Either field may be
 * absent even when the facility has an entry at all.
 */
export interface SitingContext {
  nearestWater?: NearestWater;
  nearestTransmission?: NearestTransmission;
}

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

/**
 * `data/siting-context.json` is a static, pre-computed artifact keyed by
 * facility id — mirrors how `lib/data.ts` imports `data/facilities.json`.
 * No DB, no async, no cache: it's immutable for the process lifetime.
 * 725 of 727 facilities have an entry; 2 have none.
 */
const sitingContextById = sitingContextRaw as Record<string, SitingContext>;

export function getSitingContext(id: string): SitingContext | undefined {
  return sitingContextById[id];
}
