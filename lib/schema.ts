import { z } from "zod";
import { STATUS_ORDER } from "@/lib/status";

export const statusEnum = z.enum(STATUS_ORDER);
export const aiClassificationEnum = z.enum(["confirmed", "likely", "mixed_use"]);
export const confidenceEnum = z.enum(["confirmed", "reported", "rumored"]);
export const facilityTypeEnum = z.enum(["data_center", "crypto_mining"]);
export const sourceKindEnum = z.enum([
  "press",
  "permit",
  "osm",
  "iso_queue",
  "subsidy",
  "filing",
  "other",
]);

export const sourceSchema = z.object({
  url: z.string().url(),
  label: z.string().min(1),
  publisher: z.string().optional(),
  retrievedAt: z.string().min(4),
  kind: sourceKindEnum.default("other"),
});

export const statusEventSchema = z.object({
  status: statusEnum,
  date: z.string().min(4),
  note: z.string().optional(),
  sourceIndex: z.number().int().nonnegative().optional(),
});

// Shared fields common to every facility, regardless of type.
// Both discriminated-union branches spread this shape and add their own
// `facilityType` literal plus type-specific fields.
const baseFacilityShape = {
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, "id must be a lowercase kebab slug"),
  name: z.string().min(1),
  operator: z.string().min(1),
  status: statusEnum,
  confidence: confidenceEnum,
  location: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    city: z.string().optional(),
    county: z.string().optional(),
    state: z.string().length(2),
  }),
  capacityMw: z
    .object({
      planned: z.number().positive().optional(),
      operational: z.number().positive().optional(),
    })
    .optional(),
  poweredBy: z.string().optional(),
  announcedDate: z.string().optional(),
  statusHistory: z.array(statusEventSchema).default([]),
  sources: z.array(sourceSchema).min(1, "at least one source is required"),
  lastUpdated: z.string().min(4),
  notes: z.string().optional(),
  // energy / power
  energy: z
    .object({
      source: z
        .enum(["grid", "on_site_gas", "nuclear", "solar", "wind", "hydro", "mixed", "other"])
        .optional(),
      utility: z.string().optional(),
      onSiteGenerationMw: z.number().positive().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  // water
  water: z
    .object({
      coolingType: z.enum(["evaporative", "air", "closed_loop", "hybrid", "unknown"]).optional(),
      reportedMgd: z.number().nonnegative().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  // public money
  subsidies: z
    .array(
      z.object({
        program: z.string().optional(),
        amountUsd: z.number().nonnegative().optional(),
        jurisdiction: z.string().optional(),
        year: z.string().optional(),
        sourceIndex: z.number().int().nonnegative().optional(),
      })
    )
    .optional(),
  // economics
  investmentUsd: z.number().positive().optional(),
  landAcres: z.number().positive().optional(),
  jobs: z
    .object({
      construction: z.number().int().nonnegative().optional(),
      permanent: z.number().int().nonnegative().optional(),
      sourceIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
  // community
  community: z
    .object({
      status: z
        .enum(["supported", "mixed", "contested", "opposed", "litigation", "unknown"])
        .optional(),
      notes: z.string().optional(),
      sourceIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
};

// Data-center-specific environmental metrics.
const dataCenterEnvironmentalSchema = z.object({
  pue: z.number().optional(),
  pueConfidence: confidenceEnum.optional(),
  wue: z.number().optional(),
  gridCarbonIntensityGCo2PerKwh: z.number().optional(),
  renewablePercent: z.number().min(0).max(100).optional(),
  waterStress: z.enum(["low", "medium", "high", "extreme", "unknown"]).default("unknown"),
});

// Crypto-mining-specific operational fields.
const miningSchema = z.object({
  hashRateThPerS: z.number().optional(),
  hardwareType: z.enum(["asic", "gpu", "mixed", "unknown"]).optional(),
  coolingType: z.enum(["immersion", "air", "hydro", "hybrid", "unknown"]).optional(),
  powerArrangement: z
    .enum([
      "grid",
      "stranded_gas",
      "flared_gas",
      "curtailed_renewable",
      "behind_meter",
      "mixed",
      "unknown",
    ])
    .optional(),
});

// Crypto-mining-specific environmental metrics.
const cryptoMiningEnvironmentalSchema = z.object({
  carbonIntensityProxy: z.number().optional(),
  carbonIntensityBasis: z
    .enum(["self_reported", "grid_average", "estimated", "unknown"])
    .optional(),
});

export const dataCenterFacilitySchema = z.object({
  ...baseFacilityShape,
  facilityType: z.literal("data_center"),
  aiClassification: aiClassificationEnum,
  environmental: dataCenterEnvironmentalSchema.optional(),
});

export const cryptoMiningFacilitySchema = z.object({
  ...baseFacilityShape,
  facilityType: z.literal("crypto_mining"),
  aiClassification: aiClassificationEnum.optional(),
  mining: miningSchema.optional(),
  environmental: cryptoMiningEnvironmentalSchema.optional(),
});

// Shared cross-branch validation: sourceIndex fields must reference an
// in-range entry in `sources[]`. Hoisted so both union branches enforce it
// identically instead of duplicating the superRefine per-branch.
function checkSourceIndexBounds(
  data: {
    sources: { url: string }[];
    statusHistory: { sourceIndex?: number }[];
    subsidies?: { sourceIndex?: number }[];
    jobs?: { sourceIndex?: number };
    community?: { sourceIndex?: number };
  },
  ctx: z.RefinementCtx
) {
  const sourceCount = data.sources.length;
  const checkIndex = (idx: number | undefined, path: (string | number)[]) => {
    if (idx !== undefined && idx >= sourceCount) {
      ctx.addIssue({
        code: "custom",
        message: `sourceIndex ${idx} is out of range (sources has ${sourceCount} item(s))`,
        path,
      });
    }
  };
  data.statusHistory.forEach((event, i) =>
    checkIndex(event.sourceIndex, ["statusHistory", i, "sourceIndex"])
  );
  data.subsidies?.forEach((s, i) =>
    checkIndex(s.sourceIndex, ["subsidies", i, "sourceIndex"])
  );
  checkIndex(data.jobs?.sourceIndex, ["jobs", "sourceIndex"]);
  checkIndex(data.community?.sourceIndex, ["community", "sourceIndex"]);
}

export const facilitySchema = z
  .discriminatedUnion("facilityType", [
    dataCenterFacilitySchema,
    cryptoMiningFacilitySchema,
  ])
  .superRefine(checkSourceIndexBounds);

export const facilitiesSchema = z.array(facilitySchema);

export type Facility = z.infer<typeof facilitySchema>;
export type DataCenterFacility = z.infer<typeof dataCenterFacilitySchema>;
export type CryptoMiningFacility = z.infer<typeof cryptoMiningFacilitySchema>;
export type Source = z.infer<typeof sourceSchema>;
export type StatusEvent = z.infer<typeof statusEventSchema>;
