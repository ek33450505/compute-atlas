/**
 * Shared source of truth for the map's optional-overlay color ramps and
 * satellite-visibility rules. Both the MapLibre paint expressions
 * (components/map/facility-map.tsx) and the Layers control legend
 * (components/map/map-layer-control.tsx) import from here so the two never
 * drift out of sync.
 *
 * Ramps are single-hue, light -> dark (severity by luminance) — the
 * maintainer is color-deficient, so severity must never rely on hue alone.
 */

/** Baseline water stress ramp, keyed on bws_cat (0 = low .. 4 = extremely high). */
export const WATER_STRESS_RAMP = [
  "#DCEAF2",
  "#AFCBDC",
  "#7CA9C0",
  "#4A80A0",
  "#1E4E6B",
] as const;

/** Groundwater decline ramp, keyed on gtd_cat (0 = low .. 4 = high). */
export const GROUNDWATER_RAMP = [
  "#EDE3F0",
  "#CDB3DA",
  "#A87FC0",
  "#7D4F9E",
  "#4A2A66",
] as const;

/** Drought severity ramp, keyed on dm (0 = D0/abnormally dry .. 4 = D4/exceptional). */
export const DROUGHT_RAMP = ["#EBD9B0", "#E3C489", "#D69C5A", "#B5702F", "#8F4108"] as const;

export const AQUIFER_FILL_COLOR = "#C9B79C";
export const AQUIFER_OUTLINE_COLOR = "#8A7A5C";
export const WATERWAYS_COLOR = "#5E7D8A";
export const TRANSMISSION_COLOR = "#8F4108";

/**
 * Ordered severity labels for each distribution, most-severe-first, so the
 * legend can zip a distribution's keys against the matching ramp color by
 * index. Distribution label text comes from public/data/map-layers.json and
 * is authored independently of this file, so lookups are matched
 * case/whitespace-insensitively and fall back gracefully for unknown labels.
 */
const WATER_STRESS_LABEL_ORDER = [
  "Extremely High (>80%)",
  "High (40-80%)",
  "Medium - High (20-40%)",
  "Low - Medium (10-20%)",
  "Low (<10%)",
  "Arid and Low Water Use",
] as const;

// WRI Aqueduct's groundwater-decline metric has 5 severity bands (cat 0-4,
// matching GROUNDWATER_RAMP's 5 colors). "Extremely High (>8 cm/y)" is
// included here even though the current facility distribution has zero
// facilities in that band (so it's simply absent from map-layers.json's
// `distribution` object) — omitting it here would shift every other
// label's ramp-color index by one.
const GROUNDWATER_LABEL_ORDER = [
  "Extremely High (>8 cm/y)",
  "High (4-8 cm/y)",
  "Medium - High (2-4 cm/y)",
  "Low - Medium (0-2 cm/y)",
  "Low (<0 cm/y)",
] as const;

/** Drought key labels, D4 (most severe) first — no per-facility counts exist for drought. */
export const DROUGHT_KEY_LABELS = [
  "D4 — Exceptional",
  "D3 — Extreme",
  "D2 — Severe",
  "D1 — Moderate",
  "D0 — Abnormally Dry",
] as const;

function normalize(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Maps a distribution label (as it appears in map-layers.json) to a ramp
 * color, given the ramp and the label's known severity order (most-severe
 * first). Returns undefined for a label not present in the known order,
 * rather than throwing — new/renamed labels in the manifest degrade to "no
 * swatch" instead of breaking the legend.
 */
export function colorForLabel(
  label: string,
  labelOrder: readonly string[],
  ramp: readonly string[]
): string | undefined {
  const index = labelOrder.findIndex((known) => normalize(known) === normalize(label));
  if (index === -1) return undefined;
  // Ramp is ordered low -> high severity; labelOrder is most-severe-first.
  const rampIndex = ramp.length - 1 - index;
  return ramp[Math.max(0, Math.min(ramp.length - 1, rampIndex))];
}

export function colorForWaterStressLabel(label: string): string | undefined {
  return colorForLabel(label, WATER_STRESS_LABEL_ORDER, WATER_STRESS_RAMP);
}

export function colorForGroundwaterLabel(label: string): string | undefined {
  return colorForLabel(label, GROUNDWATER_LABEL_ORDER, GROUNDWATER_RAMP);
}

/**
 * Returns a distribution's entries (label + count) ordered most-severe-first
 * per the given label order, appending any unrecognized labels (present in
 * the data but not in the known order) at the end so nothing silently drops.
 */
export function orderedDistribution(
  distribution: Record<string, number>,
  labelOrder: readonly string[]
): Array<{ label: string; count: number }> {
  const known = labelOrder
    .filter((label) => label in distribution)
    .map((label) => ({ label, count: distribution[label] }));
  const knownSet = new Set(labelOrder.map(normalize));
  const unknown = Object.entries(distribution)
    .filter(([label]) => !knownSet.has(normalize(label)))
    .map(([label, count]) => ({ label, count }));
  return [...known, ...unknown];
}

export function orderedWaterStressDistribution(
  distribution: Record<string, number>
): Array<{ label: string; count: number }> {
  return orderedDistribution(distribution, WATER_STRESS_LABEL_ORDER);
}

export function orderedGroundwaterDistribution(
  distribution: Record<string, number>
): Array<{ label: string; count: number }> {
  return orderedDistribution(distribution, GROUNDWATER_LABEL_ORDER);
}

/**
 * Overlay ids whose map representation is a pure fill (no visible line/edge)
 * and therefore disappears — with no visual trace — under the satellite
 * basemap. The Layers control disables their toggles when satellite is
 * active rather than letting users toggle a layer they can't see.
 */
export const FILL_ONLY_OVERLAY_IDS = ["waterStress", "groundwater", "drought"] as const;

export type FillOnlyOverlayId = (typeof FILL_ONLY_OVERLAY_IDS)[number];
