import type { Facility } from "@/lib/schema";

/**
 * Flat CSV view of the facility dataset, one row per facility.
 *
 * Column choice: the scalar fields of `facilitySchema` (lib/schema.ts), the shared
 * base plus each facilityType variant. Nested scalars use dotted names
 * (`capacityMw.operational`, `location.lat`). A column that does not apply to a
 * facility's type (e.g. `mining.hashRateThPerS` on a data center) is an empty cell.
 * Multi-valued fields are `;`-joined; `sources.url` lists every source URL (a literal
 * `;` inside a URL is written `%3B` so the separator stays unambiguous).
 *
 * Deliberately NOT flattened, because they are records rather than scalars and the
 * JSON edition carries them: `statusHistory`, `emissions`, `subsidies`, `stakeholders`,
 * `notRecorded`, the free-text `notes` fields and each source's label/publisher/date.
 *
 * Format: RFC 4180 (CRLF line endings, a cell is quoted when it holds a comma,
 * double quote, CR or LF, embedded quotes are doubled), UTF-8, no BOM.
 *
 * CSV-injection rule: a spreadsheet treats a cell that starts with `=`, `+`, `-`,
 * `@`, TAB or CR as a formula. A string cell, or the joined text of a list, starting
 * with one of those gets a leading `'`, which Excel and Sheets display as plain
 * text. NUMBERS are written as numbers, untouched, so a coordinate like `-97.5`
 * stays `-97.5`; only text (names, operators, free-form strings) can carry a
 * formula payload.
 */

type Cell = string | number | readonly string[] | null | undefined;
type Column = readonly [name: string, get: (f: Facility) => Cell];

const COLUMNS: readonly Column[] = [
  ["id", (f) => f.id],
  ["name", (f) => f.name],
  ["facilityType", (f) => f.facilityType],
  ["status", (f) => f.status],
  ["confidence", (f) => f.confidence],
  ["operator", (f) => f.operator],
  ["location.state", (f) => f.location.state],
  ["location.city", (f) => f.location.city],
  ["location.county", (f) => f.location.county],
  ["location.street", (f) => f.location.street],
  ["location.postalCode", (f) => f.location.postalCode],
  ["location.lat", (f) => f.location.lat],
  ["location.lon", (f) => f.location.lon],
  ["location.precision", (f) => f.location.precision],
  ["location.multiSite.states", (f) => f.location.multiSite?.states],
  ["capacityMw.operational", (f) => f.capacityMw?.operational],
  ["capacityMw.planned", (f) => f.capacityMw?.planned],
  ["poweredBy", (f) => f.poweredBy],
  ["announcedDate", (f) => f.announcedDate],
  ["lastUpdated", (f) => f.lastUpdated],
  ["energy.source", (f) => f.energy?.source],
  ["energy.utility", (f) => f.energy?.utility],
  ["energy.onSiteGenerationMw", (f) => f.energy?.onSiteGenerationMw],
  ["water.coolingType", (f) => f.water?.coolingType],
  ["water.reportedMgd", (f) => f.water?.reportedMgd],
  ["investmentUsd", (f) => f.investmentUsd],
  ["landAcres", (f) => f.landAcres],
  ["jobs.construction", (f) => f.jobs?.construction],
  ["jobs.permanent", (f) => f.jobs?.permanent],
  ["community.status", (f) => f.community?.status],
  ["aiClassification", (f) => (f.facilityType === "power_generation" ? undefined : f.aiClassification)],
  // data_center
  ["environmental.pue", (f) => (f.facilityType === "data_center" ? f.environmental?.pue : undefined)],
  ["environmental.pueConfidence", (f) => (f.facilityType === "data_center" ? f.environmental?.pueConfidence : undefined)],
  ["environmental.wue", (f) => (f.facilityType === "data_center" ? f.environmental?.wue : undefined)],
  [
    "environmental.gridCarbonIntensityGCo2PerKwh",
    (f) => (f.facilityType === "data_center" ? f.environmental?.gridCarbonIntensityGCo2PerKwh : undefined),
  ],
  ["environmental.renewablePercent", (f) => (f.facilityType === "data_center" ? f.environmental?.renewablePercent : undefined)],
  ["environmental.waterStress", (f) => (f.facilityType === "data_center" ? f.environmental?.waterStress : undefined)],
  // crypto_mining
  ["mining.hashRateThPerS", (f) => (f.facilityType === "crypto_mining" ? f.mining?.hashRateThPerS : undefined)],
  ["mining.hardwareType", (f) => (f.facilityType === "crypto_mining" ? f.mining?.hardwareType : undefined)],
  ["mining.coolingType", (f) => (f.facilityType === "crypto_mining" ? f.mining?.coolingType : undefined)],
  ["mining.powerArrangement", (f) => (f.facilityType === "crypto_mining" ? f.mining?.powerArrangement : undefined)],
  [
    "environmental.carbonIntensityProxy",
    (f) => (f.facilityType === "crypto_mining" ? f.environmental?.carbonIntensityProxy : undefined),
  ],
  [
    "environmental.carbonIntensityBasis",
    (f) => (f.facilityType === "crypto_mining" ? f.environmental?.carbonIntensityBasis : undefined),
  ],
  // power_generation
  ["generation.technology", (f) => (f.facilityType === "power_generation" ? f.generation?.technology : undefined)],
  ["generation.offtaker", (f) => (f.facilityType === "power_generation" ? f.generation?.offtaker : undefined)],
  ["generation.unitCount", (f) => (f.facilityType === "power_generation" ? f.generation?.unitCount : undefined)],
  [
    "generation.poweredFacilityIds",
    (f) => (f.facilityType === "power_generation" ? f.generation?.poweredFacilityIds : undefined),
  ],
  ["sources.url", (f) => f.sources.map((s) => s.url.replaceAll(";", "%3B"))],
];

/** The fixed, ordered header row of the CSV edition. */
export const CSV_COLUMNS: readonly string[] = COLUMNS.map(([name]) => name);

/** How many columns the CSV edition has, for public copy that quotes it. */
export const CSV_COLUMN_COUNT = COLUMNS.length;

const FORMULA_START = /^[=+\-@\t\r]/;

function renderCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = typeof value === "string" ? value : value.join(";");
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row per facility, header first, CRLF after every row (the last included). */
export function facilitiesToCsv(facilities: Facility[]): string {
  const lines = [CSV_COLUMNS.join(","), ...facilities.map((f) => COLUMNS.map(([, get]) => renderCell(get(f))).join(","))];
  return lines.map((line) => `${line}\r\n`).join("");
}
