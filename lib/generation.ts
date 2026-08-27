/**
 * Power-generation technology metadata.
 *
 * Mirrors the small ordered-meta-map pattern in lib/facility-type.ts /
 * lib/status.ts. Kept to labels/order only for now.
 */

/** All 10 generation technology keys (stable, exhaustive — mirrors schema `generation.technology` enum). */
export const GENERATION_TECHNOLOGY_ORDER = [
  "nuclear_smr",
  "nuclear",
  "fusion",
  "natural_gas",
  "solar",
  "wind",
  "hydro",
  "geothermal",
  "battery",
  "other",
] as const;

export type GenerationTechnology = (typeof GENERATION_TECHNOLOGY_ORDER)[number];

/** Human-readable labels for the generation technology enum. */
export const GENERATION_TECHNOLOGY_LABELS: Record<GenerationTechnology, string> = {
  nuclear_smr: "Nuclear · SMR",
  nuclear: "Nuclear · conventional",
  fusion: "Fusion",
  natural_gas: "Natural gas",
  solar: "Solar",
  wind: "Wind",
  hydro: "Hydro",
  geothermal: "Geothermal",
  battery: "Battery",
  other: "Other",
};

/** Label for a generation technology value; falls back to "Technology unknown" when absent. */
export function getGenerationTechnologyLabel(
  tech: GenerationTechnology | undefined
): string {
  return tech ? GENERATION_TECHNOLOGY_LABELS[tech] : "Technology unknown";
}

/**
 * Fuel classification for the /power "What's being built" buildout
 * comparison: whether a technology burns a fossil fuel, doesn't, or can't be
 * classified either way.
 *
 * `battery` is storage, not generation — counting it toward either bucket
 * would misstate what was built, not just how. `other` is an unknown mix by
 * definition. Both are `unclassified` and are excluded from the comparison
 * entirely (see `getGenerationBuildoutStats` in lib/data.ts).
 *
 * This exists so the page copy and its aggregate math read from one place and
 * cannot drift apart.
 */
export type GenerationFuelClass = "fossil" | "non_fossil" | "unclassified";

/**
 * Exhaustive `Record` (not a switch/Set) over `GenerationTechnology` — adding
 * an 11th enum key without updating this map is a compile error, which is the
 * point: this classification must never silently go stale.
 */
export const GENERATION_FUEL_CLASS: Record<GenerationTechnology, GenerationFuelClass> = {
  natural_gas: "fossil",
  nuclear_smr: "non_fossil",
  nuclear: "non_fossil",
  fusion: "non_fossil",
  solar: "non_fossil",
  wind: "non_fossil",
  hydro: "non_fossil",
  geothermal: "non_fossil",
  battery: "unclassified",
  other: "unclassified",
};

/** Fuel class for a generation technology value; `undefined` is `"unclassified"`. */
export function getGenerationFuelClass(
  tech: GenerationTechnology | undefined
): GenerationFuelClass {
  return tech ? GENERATION_FUEL_CLASS[tech] : "unclassified";
}
