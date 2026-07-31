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
 * `data/siting-context.json` is a static, pre-computed artifact keyed by
 * facility id — mirrors how `lib/data.ts` imports `data/facilities.json`.
 * No DB, no async, no cache: it's immutable for the process lifetime.
 * 725 of 727 facilities have an entry; 2 have none.
 */
const sitingContextById = sitingContextRaw as Record<string, SitingContext>;

export function getSitingContext(id: string): SitingContext | undefined {
  return sitingContextById[id];
}
