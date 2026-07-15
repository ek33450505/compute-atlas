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

/** Human-readable labels for the aiClassification enum. */
export const AI_CLASSIFICATION_LABELS: Record<string, string> = {
  confirmed: "AI-specific",
  likely: "Likely AI-specific",
  mixed_use: "Mixed-use",
};

/** Human-readable labels for the confidence enum. */
export const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  reported: "Reported",
  rumored: "Rumored",
};

/**
 * Formats a USD value using compact notation (e.g. "$3.5B", "$450M", "$2.9M").
 * Uses at most one decimal digit.
 */
export function formatUsdCompact(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
    // Without this, ICU's compact-notation trailing-zero handling varies by
    // Node/ICU version — e.g. "$450M" locally vs "$450.0M" on Node 22 in CI.
    // stripIfInteger normalizes this: the fraction is dropped only when the
    // compact value is a whole number, so "$3.5B"/"$2.9M" are unaffected.
    trailingZeroDisplay: "stripIfInteger",
  }).format(n);
}
