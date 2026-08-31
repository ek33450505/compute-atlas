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

/**
 * Every read path that only needs `Facility` data selects a `doc`-only
 * projection (`.select({ doc: facilitiesTable.doc })`), never `SELECT *` —
 * the scalar columns above exist purely for the DB to filter/order on, and
 * shipping them back over the wire when nothing reads them wastes ~24% of
 * the response (measured against the live Neon HTTP endpoint, 2026-08-31).
 * The parameter is `Pick<FacilityRow, "doc">` rather than the full row so a
 * partial select still typechecks — structural typing means a full
 * `FacilityRow` (or a `{ id, doc }` fixture) satisfies it too.
 */
export function rowToFacility(row: Pick<FacilityRow, "doc">): Facility {
  return row.doc;
}
