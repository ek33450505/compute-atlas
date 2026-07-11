/**
 * Facility-type metadata (data center vs. crypto mining).
 *
 * Mirrors the small ordered-meta-map pattern in lib/status.ts. Kept to
 * labels/order only for now — a later unit (map markers) may extend this
 * with a shape/visual field once that need is concrete.
 */

export const FACILITY_TYPE_ORDER = ["data_center", "crypto_mining", "power_generation"] as const;

export type FacilityType = (typeof FACILITY_TYPE_ORDER)[number];

export interface FacilityTypeMeta {
  label: string;
}

export const FACILITY_TYPE_META: Record<FacilityType, FacilityTypeMeta> = {
  data_center: { label: "Data center" },
  crypto_mining: { label: "Crypto mining" },
  power_generation: { label: "Power generation" },
};

/**
 * Returns the FacilityTypeMeta for a given facility type value.
 */
export function getFacilityTypeMeta(t: FacilityType): FacilityTypeMeta {
  return FACILITY_TYPE_META[t];
}
