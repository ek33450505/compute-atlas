import { STATUS_META, type Status } from "@/lib/status";
import type { Facility } from "@/lib/schema";

/**
 * Returns the maximum of operational/planned capacity in MW, or undefined if
 * the facility has no capacity data.
 */
export function getFacilityMaxMw(f: Facility): number | undefined {
  const operational = f.capacityMw?.operational;
  const planned = f.capacityMw?.planned;
  if (operational !== undefined && planned !== undefined) {
    return Math.max(operational, planned);
  }
  return operational ?? planned;
}

/**
 * Returns a human-readable capacity string:
 * - "150 MW"              when operational capacity is present
 * - "1,200 MW planned"    when only planned capacity is present
 * - "—"                   when no capacity data is available
 */
export function formatCapacity(f: Facility): string {
  const operational = f.capacityMw?.operational;
  const planned = f.capacityMw?.planned;
  if (operational !== undefined) {
    return `${operational.toLocaleString()} MW`;
  }
  if (planned !== undefined) {
    return `${planned.toLocaleString()} MW planned`;
  }
  return "—";
}

/**
 * Returns a location string in the form "City, ST" or just "ST" when city is
 * absent.
 */
export function formatLocation(f: Facility): string {
  const { city, state } = f.location;
  if (city) {
    return `${city}, ${state}`;
  }
  return state;
}

/**
 * Returns the human-readable status label from STATUS_META.
 */
export function formatStatusLabel(s: Status): string {
  return STATUS_META[s].label;
}
