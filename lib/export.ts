import type { Facility } from "@/lib/schema";
import { siteConfig } from "@/lib/site";

interface CsvColumn {
  header: string;
  value: (f: Facility) => string | number | undefined;
}

// Flat, machine-readable column set (raw enum values, not display labels).
export const CSV_COLUMNS: CsvColumn[] = [
  { header: "id", value: (f) => f.id },
  { header: "name", value: (f) => f.name },
  { header: "operator", value: (f) => f.operator },
  { header: "facility_type", value: (f) => f.facilityType },
  { header: "status", value: (f) => f.status },
  {
    header: "ai_classification",
    value: (f) => (f.facilityType !== "power_generation" ? f.aiClassification : undefined),
  },
  { header: "confidence", value: (f) => f.confidence },
  { header: "city", value: (f) => f.location.city },
  { header: "county", value: (f) => f.location.county },
  { header: "state", value: (f) => f.location.state },
  { header: "lat", value: (f) => f.location.lat },
  { header: "lon", value: (f) => f.location.lon },
  { header: "capacity_operational_mw", value: (f) => f.capacityMw?.operational },
  { header: "capacity_planned_mw", value: (f) => f.capacityMw?.planned },
  {
    header: "offtaker",
    value: (f) => (f.facilityType === "power_generation" ? f.generation?.offtaker : undefined),
  },
  { header: "announced_date", value: (f) => f.announcedDate },
  { header: "last_updated", value: (f) => f.lastUpdated },
  { header: "detail_url", value: (f) => `${siteConfig.url}/facilities/${f.id}` },
];

// Wrap in quotes + double internal quotes only when the field contains , " CR or LF.
function escapeCsvField(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serializes facilities to CSV (header + one row each), CRLF line endings. */
export function facilitiesToCsv(facilities: Facility[]): string {
  const header = CSV_COLUMNS.map((c) => c.header).join(",");
  const rows = facilities.map((f) =>
    CSV_COLUMNS.map((c) => escapeCsvField(c.value(f))).join(",")
  );
  return [header, ...rows].join("\r\n");
}

/** Serializes facilities to pretty-printed JSON (same shape as data/facilities.json). */
export function facilitiesToJson(facilities: Facility[]): string {
  return JSON.stringify(facilities, null, 2);
}
