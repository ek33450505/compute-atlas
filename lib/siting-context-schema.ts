import { z } from "zod";

/**
 * Siting-context zod schemas, free of any `data/*.json` import: `scripts/export.ts` loads
 * them before `data/siting-context.json` exists (it is what creates it).
 * `lib/siting-context.ts` re-exports `sitingContextSchema`. Guarded by
 * `lib/export-import-graph.test.ts`.
 */

// Mirrors the interfaces above, typed as the renderers and formatters read each
// field (`splitRiskLabel(label)`, `distanceMi.toFixed`). Loose objects: an extra
// key is accepted and kept, so downstream readers see the exact stored shape.
export const waterStressSchema = z.looseObject({ cat: z.number(), label: z.string() });
export const sitingContextSchema = z.looseObject({
  nearestWater: z
    .looseObject({ name: z.string(), kind: z.enum(["river", "lake"]), distanceMi: z.number() })
    .nullish(),
  nearestTransmission: z.looseObject({ voltageKv: z.number(), distanceMi: z.number() }).nullish(),
  waterStress: waterStressSchema.nullish(),
  groundwaterDecline: waterStressSchema.nullish(),
  aquifer: z.looseObject({ name: z.string(), rock: z.string() }).nullish(),
});
