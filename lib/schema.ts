import { z } from "zod";
import { STATUS_ORDER } from "@/lib/status";

export const statusEnum = z.enum(STATUS_ORDER);
export const aiClassificationEnum = z.enum(["confirmed", "likely", "mixed_use"]);
export const confidenceEnum = z.enum(["confirmed", "reported", "rumored"]);
export const facilityTypeEnum = z.enum(["data_center", "crypto_mining", "power_generation"]);
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
  url: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          const { protocol } = new URL(value);
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "url must use the http or https protocol" },
    ),
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

// Sub-shapes extracted from `baseFacilityShape` so `lib/enrichment-update.ts`
// can compose an intent schema from the SAME field-level validation instead
// of duplicating it. Each export is the bare (non-optional) shape; call
// sites in `baseFacilityShape` below apply `.optional()` themselves.
export const capacityMwSchema = z.object({
  planned: z.number().positive().optional(),
  operational: z.number().positive().optional(),
});

export const energySchema = z.object({
  source: z
    .enum(["grid", "on_site_gas", "nuclear", "solar", "wind", "hydro", "mixed", "other"])
    .optional(),
  utility: z.string().optional(),
  onSiteGenerationMw: z.number().positive().optional(),
  notes: z.string().optional(),
});

// `coolingType` classifies a data center's heat-rejection method BY WATER
// CONSUMPTION — that is the axis `lib/energy.ts`'s `COOLING_TYPE_ENTRIES`
// already publishes on /power ("Evaporative (high water)" ... "Air-cooled
// (minimal)"); the two must never drift, so read this comment alongside that
// file rather than re-deriving the ordering independently.
//
//   - "evaporative" — heat is rejected by evaporating water (cooling towers,
//     adiabatic/evaporative assist). Water is consumed continuously.
//   - "hybrid" — the design switches between evaporative and dry modes (e.g.
//     wet cooling in summer, dry in winter). Water is consumed seasonally. NOT
//     "a mix of air and liquid cooling" — that is rack-level heat capture, not
//     heat rejection, and it is the misreading a local model made repeatedly
//     when the rule was absent from its prompt (bench, 2026-09-01).
//   - "closed_loop" — a recirculating water/coolant circuit that is not
//     evaporated; water is consumed only as occasional makeup.
//   - "air" — NO cooling water circuit at all: dry/direct air cooling,
//     "waterless", "zero water for cooling". Water use is limited to
//     ordinary plumbing.
//   - "unknown" — a source addresses cooling but does not identify the
//     method.
//
// TIE-BREAKER (the rule that resolves the common real-world case): if the
// facility has a water circuit that recirculates, the value is
// "closed_loop" — even when heat is ultimately rejected to air via
// air-cooled chillers or dry coolers. "air" is reserved for designs with NO
// cooling water circuit. Operators very often market a closed-loop design as
// "air-cooled" — the marketing phrase alone must not decide the value; the
// presence of a recirculating water circuit does.
//
// This is `water.coolingType`, NOT `mining.coolingType` below — a separate
// enum (`immersion`/`air`/`hydro`/`hybrid`/`unknown`) for crypto-mining rigs.
// The two share the literal values "air" and "hybrid", so a mining value can
// be assigned here and still pass validation; the definitions above are the
// ones that apply to this field.
export const waterSchema = z.object({
  coolingType: z.enum(["evaporative", "air", "closed_loop", "hybrid", "unknown"]).optional(),
  reportedMgd: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

// Permitted annual emissions limits from an air permit (PSD / Title V / state
// construction permit) — a regulatory CEILING, not measured or actual
// emissions. Never present one as the other, in copy or UI.
// Values are recorded in short tons per year (tpy), exactly as the permit
// states them. Never convert units, and never derive a tonnage from capacity
// (MW -> tons needs a capacity factor and an emission rate; a derived figure
// would be this project's first uncited number, which is not acceptable
// here). If a permit states metric tonnes or a non-annual averaging period,
// record what it says and explain the discrepancy in `notes` rather than
// normalizing it.
// `sourceIndex` must point at the permit document itself in `sources[]`.
//
// A pilot against three real air permits (Homer City PA, xAI/MZX MS,
// Waterford LA) found real permits do NOT uniformly cap emissions at the
// facility level: xAI's permit caps every pollutant PER TURBINE across three
// equipment groups, with no facility-wide tonnage for most pollutants at
// all. `basis`, `unitsCovered`, and `averagingPeriod` exist so a per-unit or
// non-calendar-year number is never mistaken for a facility-wide annual one.
export const emissionsSchema = z
  .object({
    // Values are recorded in the permit's own units, exactly as printed —
    // never convert, never annualize a short-term limit, and never derive a
    // tonnage from capacity (MW). See the field-level notes below for the
    // pollutants where the pilot found real permits diverge from what a
    // naive facility-wide annual reading would assume.
    permittedTpy: z
      .object({
        nox: z.number().nonnegative().optional(),
        co: z.number().nonnegative().optional(),
        // Total particulate matter — distinct from the PM10/PM2.5
        // size-fraction limits below; permits commonly state all three.
        pm: z.number().nonnegative().optional(),
        pm25: z.number().nonnegative().optional(),
        pm10: z.number().nonnegative().optional(),
        // Permits print this cap under either "SO2" or "SOx" — record the
        // value here regardless of the permit's own label, and note that
        // label in `notes` when it isn't "SO2". Never invent a second key
        // for SOx.
        so2: z.number().nonnegative().optional(),
        voc: z.number().nonnegative().optional(),
        // A missing `co2e` does NOT mean "no GHG limit." Some permits (e.g.
        // xAI/MZX) cap GHG only as an efficiency RATE (lb/MMBtu), with no
        // annual tonnage cap at all. Leave `co2e` undefined and explain the
        // rate-only limit in `notes` — never derive a tonnage from a rate.
        co2e: z.number().nonnegative().optional(),
        // Sulfuric acid mist.
        h2so4: z.number().nonnegative().optional(),
        // Ammonia — seen as a voluntary limit tied to SCR/urea NOx controls.
        nh3: z.number().nonnegative().optional(),
        formaldehyde: z.number().nonnegative().optional(),
        // Combined hazardous-air-pollutants cap. Individual HAPs other than
        // formaldehyde go in `notes` — they are open-ended and cannot be
        // enumerated as dedicated fields.
        hapsTotal: z.number().nonnegative().optional(),
      })
      .optional(),
    // What the tonnages in `permittedTpy` apply to. Required whenever
    // `permittedTpy` carries at least one defined value (enforced by the
    // superRefine below) — a tonnage with no `basis` is ambiguous between a
    // facility total and a single unit's limit, and this project publishing
    // one as the other would be a serious factual error.
    basis: z.enum(["facility_wide", "per_unit"]).optional(),
    // The averaging window the tonnages are measured over, as the permit
    // states it. A 12-month ROLLING total is not the same as a calendar
    // year — recording either as plain "annual" silently loses that
    // distinction.
    averagingPeriod: z.enum(["calendar_year", "rolling_12_month", "other"]).optional(),
    // The equipment the permit covers, in the permit's own terms (e.g. "41
    // combustion turbines" or "Units 1-3"). Fill this whenever the permit's
    // scope might not match the tracked facility's own description — a
    // permit can authorize a materially different unit count than the
    // facility record states elsewhere, and this is the field that catches
    // that mismatch.
    unitsCovered: z.string().min(1).optional(),
    permitNumber: z.string().min(1).optional(),
    permitType: z.enum(["psd", "title_v", "minor_source", "state_construction", "other"]).optional(),
    issuingAgency: z.string().min(1).optional(),
    issuedDate: z.string().optional(),
    notes: z.string().optional(),
    sourceIndex: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    const hasDefinedPollutant =
      data.permittedTpy !== undefined &&
      Object.values(data.permittedTpy).some((value) => value !== undefined);
    if (hasDefinedPollutant && data.basis === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "a permitted tonnage is meaningless without knowing whether it applies facility-wide or per-unit — set basis",
        path: ["basis"],
      });
    }
  });

export const subsidySchema = z.object({
  program: z.string().optional(),
  amountUsd: z.number().nonnegative().optional(),
  jurisdiction: z.string().optional(),
  year: z
    .string()
    .regex(/^\d{4}(\/\d{4})*$/, "year must be a 4-digit year, or slash-separated 4-digit years (e.g. 2013/2015)")
    .optional(),
  sourceIndex: z.number().int().nonnegative().optional(),
});

export const stakeholderRoleEnum = z.enum([
  // financial interest
  "founder",
  "controlling_owner",
  "investor",
  // corporate role
  "executive",
  "board_member",
  // site-specific
  "landowner",
  // governmental role — NOT a financial interest
  "public_official",
]);

// A named person with a documented stake in THIS facility. Site-level only:
// a source must tie the person to this site, never merely to its operator.
// `sourceIndex` and `asOf` are required — unlike jobs/community, where they are
// optional — because naming a real person without a citation is not acceptable.
export const stakeholderSchema = z.object({
  name: z.string().min(1),
  role: stakeholderRoleEnum,
  /** The entity the stake runs through, e.g. "xAI". Makes the chain explicit. */
  via: z.string().min(1).optional(),
  /** One neutral sentence stating the documented relationship. */
  note: z.string().max(300).optional(),
  sourceIndex: z.number().int().nonnegative(),
  asOf: z.string().min(4),
});

export const communityStatusEnum = z.enum([
  "supported",
  "mixed",
  "contested",
  "opposed",
  "litigation",
  "unknown",
]);

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
    street: z.string().min(1).optional(),
    postalCode: z.string().min(1).optional(),
    state: z.string().length(2),
    // "exact": lat/lon is this facility's real footprint (default — every
    // pre-existing record without this field is "exact").
    // "approximate": best-effort geocode (e.g. a street address, not a
    // parcel-confirmed point).
    // "representative_multi_site": the facility has NO single fixed
    // location (e.g. a distributed fleet of mobile/modular sites) — lat/lon
    // is an illustrative point only; see `multiSite` for the real footprint.
    precision: z.enum(["exact", "approximate", "representative_multi_site"]).optional().default("exact"),
    multiSite: z
      .object({
        states: z.array(z.string().length(2)).min(1),
        siteCountNote: z.string().optional(),
      })
      .optional(),
  }),
  capacityMw: capacityMwSchema.optional(),
  poweredBy: z.string().optional(),
  announcedDate: z.string().optional(),
  statusHistory: z.array(statusEventSchema).default([]),
  sources: z.array(sourceSchema).min(1, "at least one source is required"),
  lastUpdated: z.string().min(4),
  notes: z.string().optional(),
  // energy / power
  energy: energySchema.optional(),
  // water
  water: waterSchema.optional(),
  // air emissions (permitted limits from an air permit, not measured)
  emissions: emissionsSchema.optional(),
  // public money
  subsidies: z.array(subsidySchema).optional(),
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
      status: communityStatusEnum.optional(),
      notes: z.string().optional(),
      sourceIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
  // named people with a documented stake in this specific site
  stakeholders: z.array(stakeholderSchema).optional(),
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
  hashRateThPerS: z.number().nonnegative().optional(),
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
  aiClassification: aiClassificationEnum.optional(),
  environmental: dataCenterEnvironmentalSchema.optional(),
});

export const cryptoMiningFacilitySchema = z.object({
  ...baseFacilityShape,
  facilityType: z.literal("crypto_mining"),
  aiClassification: aiClassificationEnum.optional(),
  mining: miningSchema.optional(),
  environmental: cryptoMiningEnvironmentalSchema.optional(),
});

// Power-generation-specific fields. Kept lean: no aiClassification, no
// mining, no environmental — capacityMw carries the generation MW and
// energy.source carries the fuel/technology at the base-shape level.
const powerGenerationSchema = z
  .object({
    technology: z
      .enum([
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
      ])
      .optional(),
    // The compute company buying the power — the link back to the buildout.
    offtaker: z.string().optional(),
    // Facility ids of the specific compute campuses this plant powers — set
    // ONLY where a single named campus is sourced (grid-region / company-level
    // PPAs use `offtaker` alone). One-directional: the reciprocal "Powered by"
    // is derived at render time from these ids, never stored on the compute
    // record.
    poweredFacilityIds: z.array(z.string()).optional(),
    unitCount: z.number().int().positive().optional(),
    notes: z.string().optional(),
  })
  .optional();

export const powerGenerationFacilitySchema = z.object({
  ...baseFacilityShape,
  facilityType: z.literal("power_generation"),
  generation: powerGenerationSchema,
});

// Shared cross-branch validation: sourceIndex fields must reference an
// in-range entry in `sources[]`. Hoisted so both union branches enforce it
// identically instead of duplicating the superRefine per-branch.
function checkSourceIndexBounds(
  data: {
    sources: { url: string }[];
    statusHistory: { sourceIndex?: number }[];
    subsidies?: { sourceIndex?: number }[];
    stakeholders?: { sourceIndex?: number }[];
    jobs?: { sourceIndex?: number };
    community?: { sourceIndex?: number };
    emissions?: { sourceIndex?: number };
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
  data.stakeholders?.forEach((s, i) =>
    checkIndex(s.sourceIndex, ["stakeholders", i, "sourceIndex"])
  );
  checkIndex(data.jobs?.sourceIndex, ["jobs", "sourceIndex"]);
  checkIndex(data.community?.sourceIndex, ["community", "sourceIndex"]);
  checkIndex(data.emissions?.sourceIndex, ["emissions", "sourceIndex"]);
}

export const facilitySchema = z
  .discriminatedUnion("facilityType", [
    dataCenterFacilitySchema,
    cryptoMiningFacilitySchema,
    powerGenerationFacilitySchema,
  ])
  .superRefine(checkSourceIndexBounds);

export const facilitiesSchema = z.array(facilitySchema);

export type Facility = z.infer<typeof facilitySchema>;
export type DataCenterFacility = z.infer<typeof dataCenterFacilitySchema>;
export type CryptoMiningFacility = z.infer<typeof cryptoMiningFacilitySchema>;
export type PowerGenerationFacility = z.infer<typeof powerGenerationFacilitySchema>;
export type Source = z.infer<typeof sourceSchema>;
export type StatusEvent = z.infer<typeof statusEventSchema>;
