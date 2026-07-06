import { getStatusMeta } from "@/lib/status";
import type { Facility } from "@/lib/schema";

/**
 * Initial view centered on the contiguous United States.
 * Zoom 3.4 shows all 48 contiguous states comfortably.
 */
export const INITIAL_VIEW_STATE = {
  longitude: -98.5,
  latitude: 39.5,
  zoom: 3.4,
} as const;

/**
 * OpenFreeMap positron style — free, no key required, low-saturation
 * for good marker contrast.
 *
 * TODO: theme-aware/dark basemap + self-hosted PMTiles later
 */
export const BASEMAP_STYLE_URL =
  "https://tiles.openfreemap.org/styles/positron";

/**
 * Builds a descriptive accessible label for a facility map marker.
 * Format: "Name, Operator — City, ST — Status — N MW [operational|planned]"
 * Capacity segment is omitted when capacityMw is not present.
 *
 * @example
 * buildMarkerLabel(colossus)
 * // "Colossus, xAI — Memphis, TN — Operational — 150 MW operational"
 */
export function buildMarkerLabel(f: Facility): string {
  const meta = getStatusMeta(f.status);
  const cityState = f.location.city
    ? `${f.location.city}, ${f.location.state}`
    : f.location.state;

  const parts: string[] = [
    `${f.name}, ${f.operator}`,
    cityState,
    meta.label,
  ];

  if (f.capacityMw?.operational !== undefined) {
    parts.push(`${f.capacityMw.operational} MW operational`);
  } else if (f.capacityMw?.planned !== undefined) {
    parts.push(`${f.capacityMw.planned} MW planned`);
  }

  return parts.join(" — ");
}
