/**
 * Power-generation technology metadata.
 *
 * Mirrors the small ordered-meta-map pattern in lib/facility-type.ts /
 * lib/status.ts. Kept to labels/order only for now.
 */

/** All 9 generation technology keys (stable, exhaustive — mirrors schema `generation.technology` enum). */
export const GENERATION_TECHNOLOGY_ORDER = [
  "nuclear_smr",
  "nuclear",
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
