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
 * Baseline water-stress category for the surrounding hydrological basin.
 * Source: WRI Aqueduct 4.0. Describes the basin, not this facility's
 * measured water use.
 */
export interface WaterStress {
  cat: number;
  label: string;
}

/**
 * Groundwater-level decline trend for the surrounding hydrological basin.
 * Source: WRI Aqueduct 4.0. Same basin-not-facility caveat as WaterStress.
 */
export interface GroundwaterDecline {
  cat: number;
  label: string;
}

/**
 * Principal aquifer system underlying the location, mapped at coarse
 * (1:2,500,000) regional resolution. Source: USGS. Regional context, not
 * site hydrogeology.
 */
export interface Aquifer {
  name: string;
  rock: string;
}

/**
 * Pre-computed siting-context entry for one facility. Any field may be
 * absent even when the facility has an entry at all.
 */
export interface SitingContext {
  nearestWater?: NearestWater;
  nearestTransmission?: NearestTransmission;
  waterStress?: WaterStress;
  groundwaterDecline?: GroundwaterDecline;
  aquifer?: Aquifer;
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
 * Splits a risk label like "Extremely High (>80%)" into a prominent
 * category word ("Extremely High") and a muted parenthetical detail
 * (">80%"). Used by waterStress/groundwaterDecline rendering — the
 * category carries the meaning (Ed is color-deficient; never rely on a
 * severity tint alone). Labels without a parenthetical return no detail.
 */
export function splitRiskLabel(label: string): {
  category: string;
  detail?: string;
} {
  const match = label.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { category: label.trim() };
  return { category: match[1].trim(), detail: match[2].trim() };
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
