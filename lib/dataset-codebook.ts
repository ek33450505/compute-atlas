import { CSV_COLUMN_NOTES } from "@/lib/dataset-csv";
import {
  communityStatusEnum,
  confidenceEnum,
  energySourceEnum,
  facilityTypeEnum,
  sourceKindEnum,
  stakeholderRoleEnum,
  statusEnum,
  waterCoolingTypeEnum,
  aiClassificationEnum,
  capacityMwSchema,
  cryptoMiningFacilitySchema,
  dataCenterFacilitySchema,
  emissionsSchema,
  emissionsUnitGroupSchema,
  NOT_RECORDABLE_FIELDS,
  permittedTpySchema,
  powerGenerationFacilitySchema,
} from "@/lib/schema";

/**
 * The public codebook (data dictionary) for the dataset editions. One source for
 * both surfaces: the "Field definitions" section of each edition's README.txt
 * (`lib/dataset-readme.ts`) and the /data page. Definitions only; no data.
 *
 * CSV-column meanings are reused from `CSV_COLUMN_NOTES`, never retyped, and enum
 * members come from the schema's own enums. Only the JSON-only fields carry
 * meanings written here.
 */

export type CodebookType = "string" | "number" | "integer" | "date" | "enum" | "list" | "object" | "array";
export type FacilityTypeValue = (typeof facilityTypeEnum.options)[number];

export interface CodebookEntry {
  path: string;
  type: CodebookType;
  unit?: string;
  values?: readonly string[];
  appliesTo: "all" | readonly FacilityTypeValue[];
  meaning: string;
  inCsv: boolean;
}

/**
 * Inline enums that lib/schema.ts does not export, read from the schema's own shapes
 * (never retyped) so a new member cannot be missed.
 */
const AVERAGING_PERIOD_VALUES = emissionsSchema.shape.averagingPeriod.unwrap().options;
const EMISSIONS_BASIS_VALUES = emissionsSchema.shape.basis.unwrap().options;
const GROUP_BASIS_VALUES = emissionsUnitGroupSchema.shape.basis.options;
const POLLUTANT_KEYS = Object.keys(permittedTpySchema.shape);
const dc = dataCenterFacilitySchema.shape;
const mining = cryptoMiningFacilitySchema.shape;
export const LOCATION_PRECISION_VALUES = dc.location.shape.precision.unwrap().unwrap().options;
const WATER_STRESS_VALUES = dc.environmental.unwrap().shape.waterStress.unwrap().options;
const HARDWARE_TYPE_VALUES = mining.mining.unwrap().shape.hardwareType.unwrap().options;
const MINING_COOLING_VALUES = mining.mining.unwrap().shape.coolingType.unwrap().options;
const POWER_ARRANGEMENT_VALUES = mining.mining.unwrap().shape.powerArrangement.unwrap().options;
const CARBON_BASIS_VALUES = mining.environmental.unwrap().shape.carbonIntensityBasis.unwrap().options;
const GENERATION_TECHNOLOGY_VALUES = powerGenerationFacilitySchema.shape.generation.unwrap().shape.technology.unwrap().options;

const DC: readonly FacilityTypeValue[] = ["data_center"];
const MINING: readonly FacilityTypeValue[] = ["crypto_mining"];
const POWER: readonly FacilityTypeValue[] = ["power_generation"];
const COMPUTE: readonly FacilityTypeValue[] = ["data_center", "crypto_mining"];

type CsvSpec = readonly [
  path: string,
  type: CodebookType,
  appliesTo: CodebookEntry["appliesTo"],
  extra?: { unit?: string; values?: readonly string[] },
];

/** One row per CSV column, in CSV order. Meaning comes from CSV_COLUMN_NOTES. */
const CSV_SPECS: readonly CsvSpec[] = [
  ["id", "string", "all"],
  ["name", "string", "all"],
  ["facilityType", "enum", "all", { values: facilityTypeEnum.options }],
  ["status", "enum", "all", { values: statusEnum.options }],
  ["confidence", "enum", "all", { values: confidenceEnum.options }],
  ["operator", "string", "all"],
  ["location.state", "string", "all"],
  ["location.city", "string", "all"],
  ["location.county", "string", "all"],
  ["location.street", "string", "all"],
  ["location.postalCode", "string", "all"],
  ["location.lat", "number", "all", { unit: "decimal degrees" }],
  ["location.lon", "number", "all", { unit: "decimal degrees" }],
  ["location.precision", "enum", "all", { values: LOCATION_PRECISION_VALUES }],
  ["location.multiSite.states", "list", "all"],
  ["capacityMw.operational", "number", "all", { unit: "MW" }],
  ["capacityMw.planned", "number", "all", { unit: "MW" }],
  ["poweredBy", "string", "all"],
  ["announcedDate", "date", "all"],
  ["lastUpdated", "date", "all"],
  ["energy.source", "enum", "all", { values: energySourceEnum.options }],
  ["energy.utility", "string", "all"],
  ["energy.onSiteGenerationMw", "number", "all", { unit: "MW" }],
  ["water.coolingType", "enum", "all", { values: waterCoolingTypeEnum.options }],
  ["water.reportedMgd", "number", "all", { unit: "million gallons per day" }],
  ["investmentUsd", "number", "all", { unit: "USD" }],
  ["landAcres", "number", "all", { unit: "acres" }],
  ["jobs.construction", "integer", "all"],
  ["jobs.permanent", "integer", "all"],
  ["community.status", "enum", "all", { values: communityStatusEnum.options }],
  ["aiClassification", "enum", COMPUTE, { values: aiClassificationEnum.options }],
  ["environmental.pue", "number", DC],
  ["environmental.pueConfidence", "enum", DC, { values: confidenceEnum.options }],
  ["environmental.wue", "number", DC],
  ["environmental.gridCarbonIntensityGCo2PerKwh", "number", DC, { unit: "gCO2/kWh" }],
  ["environmental.renewablePercent", "number", DC, { unit: "percent" }],
  ["environmental.waterStress", "enum", DC, { values: WATER_STRESS_VALUES }],
  ["mining.hashRateThPerS", "number", MINING, { unit: "TH/s" }],
  ["mining.hardwareType", "enum", MINING, { values: HARDWARE_TYPE_VALUES }],
  ["mining.coolingType", "enum", MINING, { values: MINING_COOLING_VALUES }],
  [
    "mining.powerArrangement",
    "enum",
    MINING,
    { values: POWER_ARRANGEMENT_VALUES },
  ],
  ["environmental.carbonIntensityProxy", "number", MINING],
  [
    "environmental.carbonIntensityBasis",
    "enum",
    MINING,
    { values: CARBON_BASIS_VALUES },
  ],
  [
    "generation.technology",
    "enum",
    POWER,
    { values: GENERATION_TECHNOLOGY_VALUES },
  ],
  ["generation.offtaker", "string", POWER],
  ["generation.unitCount", "integer", POWER],
  ["generation.poweredFacilityIds", "list", POWER],
  ["sources.url", "list", "all"],
  ["ids.epaFrsId", "string", "all"],
  ["ids.eiaPlantId", "integer", "all"],
  ["energy.utilityEiaId", "integer", "all"],
  ["capacityMw.basis", "enum", COMPUTE, { values: capacityMwSchema.shape.basis.unwrap().options }],
  ["capacityMw.itOperational", "number", COMPUTE, { unit: "MW" }],
  ["capacityMw.itPlanned", "number", COMPUTE, { unit: "MW" }],
  ["parties.ownerEntity", "list", "all"],
  ["parties.tenant", "list", COMPUTE],
  ["parties.endUser", "list", COMPUTE],
  ["parties.generalContractor", "list", "all"],
  ["construction.expectedStart", "date", "all"],
  ["construction.expectedCompletion", "date", "all"],
  ["construction.permitValuationUsd", "number", "all", { unit: "USD" }],
  ["construction.disturbedAcres", "number", "all", { unit: "acres" }],
  ["construction.receivingWater", "string", "all"],
  ["construction.receivingWater.segment", "string", "all"],
];

/** JSON-only fields (facilities.json), `inCsv: false`. Meanings follow the comments in lib/schema.ts. */
const JSON_ONLY: readonly CodebookEntry[] = [
  {
    path: "statusHistory[]",
    type: "array",
    appliesTo: "all",
    inCsv: false,
    meaning:
      "Dated status events. Each has status (one of the status values), date (as recorded; not format-checked), an optional note and an optional sourceIndex.",
  },
  {
    path: "sources[]",
    type: "array",
    appliesTo: "all",
    inCsv: false,
    meaning: `The public sources behind the record; at least one per record. Each has url, label, an optional publisher, retrievedAt (YYYY-MM-DD; by convention the date the source was retrieved) and kind (${sourceKindEnum.options.join(", ")}; other when unstated).`,
    values: sourceKindEnum.options,
  },
  {
    path: "emissions",
    type: "object",
    unit: "normally short tons per year",
    appliesTo: "all",
    inCsv: false,
    meaning:
      `Permitted limits from an air permit: a regulatory ceiling, not measured emissions, recorded in the units and averaging period the permit states (normally short tons per year). permittedTpy holds the limits by pollutant (${POLLUTANT_KEYS.join(", ")}). basis says whether the tonnages are ${EMISSIONS_BASIS_VALUES.join(" or ")}; averagingPeriod is ${AVERAGING_PERIOD_VALUES.join(", ")}. unitGroups lists per-equipment-group limits for permits that set different limits per group; a group's basis is ${GROUP_BASIS_VALUES.join(" or ")}. Other keys name the permit (permit number and type, issuing agency, issue date, units covered), and sourceIndex may point at the permit in sources.`,
  },
  {
    path: "subsidies[]",
    type: "array",
    appliesTo: "all",
    inCsv: false,
    meaning:
      "Public incentives tied to the site. Each may have program, amountUsd (USD), jurisdiction, year (a 4-digit year, or slash-separated years such as 2013/2015) and sourceIndex.",
  },
  {
    path: "stakeholders[]",
    type: "array",
    appliesTo: "all",
    inCsv: false,
    values: stakeholderRoleEnum.options,
    meaning:
      `By policy, named people or organizations with a documented stake in this specific site, each tied to a cited source. Each has name, an optional kind (person or organization; person when absent), role, an optional via (the entity the stake runs through), an optional note (up to 300 characters), a required sourceIndex and a required asOf. lender is for organizations only and public_official is for people only. By policy, a person is listed only when acting in a public capacity, with one exception the schema states: a landowner may be a named private individual, but only from a named public-record filing that ties them to this site.`,
  },
  {
    path: "notRecorded",
    type: "object",
    appliesTo: "all",
    inCsv: false,
    meaning:
      `Marks a field deliberately left out, with a public reason: a map from field path to reason text. Applies to ${NOT_RECORDABLE_FIELDS.join(", ")}. A field is never both set and marked.`,
  },
  {
    path: "construction.phases[]",
    type: "array",
    appliesTo: "all",
    inCsv: false,
    meaning:
      "Construction phases as stated by a source. Each has name, an optional mw (MW), optional expectedStart and expectedCompletion (YYYY, YYYY-MM or YYYY-MM-DD; forecasts) and a required sourceIndex.",
  },
  {
    path: "notes",
    type: "string",
    appliesTo: "all",
    inCsv: false,
    meaning:
      "Free-text note on the record. The same kind of free-text note exists in energy.notes, water.notes, community.notes, generation.notes, emissions.notes and emissions.unitGroups[].notes.",
  },
];

/** Every field of the dataset editions: all CSV columns first (CSV order), then the JSON-only fields. */
export const CODEBOOK_ENTRIES: readonly CodebookEntry[] = [
  ...CSV_SPECS.map(([path, type, appliesTo, extra]): CodebookEntry => {
    const meaning = CSV_COLUMN_NOTES[path];
    if (meaning === undefined) throw new Error(`dataset-codebook: no CSV_COLUMN_NOTES entry for ${path}`);
    return { path, type, appliesTo, meaning, inCsv: true, ...extra };
  }),
  ...JSON_ONLY,
];

export const CODEBOOK_CONVENTIONS: readonly string[] = [
  "A blank CSV cell is not a zero: it means no value is recorded for that field (no source recorded one, it is marked in notRecorded, or it does not apply to this facility type). location.precision is never blank (approximate when not stated). environmental.waterStress reads unknown when a data center has an environmental block that states none; a data center with no environmental block leaves it blank.",
  "notRecorded (JSON only) marks a field deliberately left out, with a public reason.",
  "Capacity, investment, land area, jobs, water use, subsidy amounts and permitted emissions are recorded as a cited source states them; Compute Atlas does not estimate them. Coordinates are a placement whose accuracy location.precision states (an approximate pin can be a town or county centroid).",
  "sourceIndex is a zero-based index into the same record's sources array.",
  "In facilities.json, ids, energy.utilityEiaId, parties and construction (including construction.phases) each carry their own sourceIndex. Construction dates are forecasts as stated by the source. The capacityMw values (planned, operational, basis, itPlanned and itOperational) are cited by the record's sources list, without a per-value index.",
  "Construction dates are YYYY, YYYY-MM or YYYY-MM-DD, and sources[].retrievedAt is YYYY-MM-DD; both are format-checked. Other dates (statusHistory, announcedDate, lastUpdated) are written as recorded, normally in the same ISO forms, but are not format-checked.",
  "location.precision: exact means the coordinates are tied to the facility itself; approximate means a best-effort placement such as a town or county centroid; representative_multi_site means an illustrative point for a facility that spans separate sites with no single fixed location. When a record does not say, it is approximate.",
];

export const STABLE_ID_STATEMENT =
  "By policy, a record id is never reused, a retired id is listed as removed in the changelog.json of the edition that removes it, and its web page redirects to a successor record where one has been named.";
