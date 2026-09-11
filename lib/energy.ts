import type { EnergySource, CoolingType } from "@/lib/data";

/** Display order + labels for `energy.source` — mirrors the § Energy section on /stats. */
export const ENERGY_SOURCE_ENTRIES: { key: EnergySource; label: string }[] = [
  { key: "grid", label: "Grid" },
  { key: "mixed", label: "Mixed" },
  { key: "on_site_gas", label: "On-site gas" },
  { key: "nuclear", label: "Nuclear" },
  { key: "solar", label: "Solar" },
  { key: "hydro", label: "Hydro" },
  { key: "wind", label: "Wind" },
  { key: "other", label: "Other" },
];

/**
 * Compile-time exhaustiveness guard, same `satisfies Record<…>` idiom as
 * lib/ai-classification.ts's `TIERS`. Every `CoolingType` member (mirrors
 * lib/schema.ts's `waterCoolingTypeEnum`) must be assigned `true` (displayed
 * below, in COOLING_TYPE_ENTRIES) or `false` (deliberately excluded) here —
 * a key missing from this object literal is a `satisfies` COMPILE ERROR, so
 * a 6th cooling type can no longer silently vanish from every /stats cooling
 * breakdown (no error today, just a missing row and a `coolingSum` that
 * quietly stops accounting for every facility). It forces a decision on
 * this line before `npm run typecheck` passes again.
 *
 * `unknown` is `false` on purpose — an unclassified facility says nothing
 * about water intensity, the axis this breakdown sorts by. Do not "fix"
 * that by flipping it to `true` and adding an Unknown row.
 *
 * This guard alone can't catch a `true` entry that never made it into
 * COOLING_TYPE_ENTRIES below (or a COOLING_TYPE_ENTRIES key that drifted
 * away from `true` here) — lib/energy.test.ts's totality test covers that
 * residual gap, mirroring lib/ai-classification.ts/.test.ts's split
 * responsibility (compile-time totality here, runtime correspondence there).
 */
export const COOLING_TYPE_DISPLAYED = {
  evaporative: true,
  hybrid: true,
  closed_loop: true,
  air: true,
  unknown: false,
} satisfies Record<CoolingType, boolean>;

/** Display order + labels for `water.coolingType` — ordered by water intensity (high -> minimal), mirrors /stats § Water use. Keys are exactly COOLING_TYPE_DISPLAYED's `true` entries above (checked in lib/energy.test.ts). */
export const COOLING_TYPE_ENTRIES: { key: CoolingType; label: string }[] = [
  { key: "evaporative", label: "Evaporative (high water)" },
  { key: "hybrid", label: "Hybrid" },
  { key: "closed_loop", label: "Closed-loop (low water)" },
  { key: "air", label: "Air-cooled (minimal)" },
];
