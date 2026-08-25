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

/** Display order + labels for `water.coolingType` — ordered by water intensity (high -> minimal), mirrors /stats § Water use. */
export const COOLING_TYPE_ENTRIES: { key: CoolingType; label: string }[] = [
  { key: "evaporative", label: "Evaporative (high water)" },
  { key: "hybrid", label: "Hybrid" },
  { key: "closed_loop", label: "Closed-loop (low water)" },
  { key: "air", label: "Air-cooled (minimal)" },
];
