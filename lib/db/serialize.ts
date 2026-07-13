import type { Facility } from "@/lib/schema";
import type { FacilityRow } from "@/lib/db/schema";

/**
 * The single place the doc<->columns mapping lives. The `doc` jsonb column
 * is the source of truth; the scalar columns are derived from it purely for
 * indexing/filtering — never validated independently of the Facility Zod
 * schema.
 */
export function docToRow(f: Facility) {
  return {
    id: f.id,
    doc: f,
    name: f.name,
    operator: f.operator,
    state: f.location.state,
    status: f.status,
    facilityType: f.facilityType,
    confidence: f.confidence,
    capacityOperationalMw: f.capacityMw?.operational ?? null,
    capacityPlannedMw: f.capacityMw?.planned ?? null,
    lat: f.location.lat,
    lon: f.location.lon,
    announcedDate: f.announcedDate ?? null,
    lastUpdated: f.lastUpdated,
  };
}

export function rowToFacility(row: FacilityRow): Facility {
  return row.doc;
}
