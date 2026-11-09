import { facilitiesSchema, type Facility } from "@/lib/schema";
import { facilitiesTable, operatorOwnershipTable, sitingContextTable, type FacilityRow } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { rowToFacility } from "@/lib/db/serialize";
import { byOperator, operatorOwnershipFileSchema } from "@/lib/operator-ownership-schema";
import { sitingContextSchema } from "@/lib/siting-context-schema";

/**
 * The pure read/validate/serialize half of the data snapshot, shared by
 * `scripts/export.ts` (which writes the four files) and the weekly edition cron
 * route (which must never import from `scripts/`). No filesystem access here.
 * Like the export script, nothing in this graph may import a `data/*.json` file:
 * the export is what creates them (guarded by `lib/export-import-graph.test.ts`).
 */

/** Bumped only when the Zod `facilitySchema` shape changes in a breaking way — mirrors the API's `X-API-Version`. */
const SCHEMA_VERSION = 1;

export interface ExportMeta {
  asOf: string;
  recordCount: number;
  schemaVersion: number;
}

/**
 * Pure builder for the facilities.meta.json shape — kept separate from disk
 * I/O so it's testable without a DB or a package.json read (see scripts/export.test.ts).
 *
 * `now` should be the instant the DB read STARTED, not when the file was
 * written — see the comment at its call site in `exportSnapshot`. The default
 * exists for tests and ad-hoc use; the CLI always passes an explicit value.
 */
export function buildExportMeta(
  recordCount: number,
  now: Date = new Date()
): ExportMeta {
  return {
    asOf: now.toISOString(),
    recordCount,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Row-count floors: a read below one means a truncated, stale or wrong-branch
 * read, and a snapshot built from it must never replace the real files. Set
 * against what Neon held on 2026-11-06 (3,025 facilities, 3,025 siting rows,
 * 26 ownership rows): 2900 is about 96% of 3,025, 24 is about 92% of 26. That
 * catches a stale or branch-scoped DATABASE_URL.
 * Raise these as the dataset grows; a legitimate shrink below them needs a
 * deliberate edit here.
 */
export const MIN_FACILITIES = 2900;
export const MIN_SITING_ROWS = 2900;
export const MIN_OWNERSHIP_ROWS = 24;

export interface SnapshotSource {
  facilities(): Promise<Array<Pick<FacilityRow, "doc">>>;
  sitingContext(): Promise<Array<{ facilityId: string; data: unknown }>>;
  operatorOwnership(): Promise<Array<{ data: unknown }>>;
}

export interface SnapshotFloors {
  facilities: number;
  siting: number;
  ownership: number;
}

export const DEFAULT_FLOORS: SnapshotFloors = {
  facilities: MIN_FACILITIES,
  siting: MIN_SITING_ROWS,
  ownership: MIN_OWNERSHIP_ROWS,
};

export function neonSource(): SnapshotSource {
  const db = getDb();
  return {
    facilities: () => db.select().from(facilitiesTable),
    sitingContext: () =>
      db.select({ facilityId: sitingContextTable.facilityId, data: sitingContextTable.data }).from(sitingContextTable),
    operatorOwnership: () => db.select({ data: operatorOwnershipTable.data }).from(operatorOwnershipTable),
  };
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** A JSON null on a siting field means absent (same rule as lib/siting-context.ts withoutNulls). */
const dropNulls = (entry: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== null));

export interface SnapshotBuild {
  /** `[file name, serialized body]` in write order: facilities, meta, siting, ownership. */
  bodies: Array<[name: string, body: string]>;
  facilities: Facility[];
  siting: Record<string, unknown>;
  /** Facilities with no siting_context row. Reported, never fatal: new records lack siting until a local refresh. */
  missingSiting: number;
  /** siting_context rows whose facility_id is not in facilities. Reported, still serialized. */
  orphanSiting: number;
}

export interface SnapshotBuildOptions {
  floors: SnapshotFloors;
  /**
   * The instant stamped into facilities.meta.json as `asOf`. The CALLER takes it
   * BEFORE this function reads the source; see the comment in `exportSnapshot`.
   */
  readAt: Date;
  warn?: (msg: string) => void;
}

/**
 * Reads the source, floor-checks, re-validates and serializes the four snapshot
 * bodies. Everything is validated BEFORE anything is returned, so a throw here
 * means no caller has a partial set to write.
 */
export async function buildSnapshotBodies(
  source: SnapshotSource,
  { floors, readAt, warn = (m: string) => console.warn(m) }: SnapshotBuildOptions
): Promise<SnapshotBuild> {
  const [facilityRows, sitingRows, ownershipRows] = await Promise.all([
    source.facilities(),
    source.sitingContext(),
    source.operatorOwnership(),
  ]);

  if (facilityRows.length < floors.facilities) {
    throw new Error(`export refused: ${facilityRows.length} facilities is below the floor of ${floors.facilities}`);
  }
  if (sitingRows.length < floors.siting) {
    throw new Error(`export refused: ${sitingRows.length} siting_context rows is below the floor of ${floors.siting}`);
  }
  if (ownershipRows.length < floors.ownership) {
    throw new Error(`export refused: ${ownershipRows.length} operator_ownership rows is below the floor of ${floors.ownership}`);
  }

  // Re-validate everything before writing — the published snapshot must be
  // schema-valid; this throws loudly on any invalid record, same as seed.ts.
  const facilities = facilitiesSchema.parse(
    facilityRows.map(rowToFacility).sort((a, b) => a.id.localeCompare(b.id))
  );

  // Keyed by facility_id in code-unit order, the committed file's order.
  const siting: Record<string, unknown> = {};
  for (const row of [...sitingRows].sort((a, b) => (a.facilityId < b.facilityId ? -1 : a.facilityId > b.facilityId ? 1 : 0))) {
    siting[row.facilityId] = dropNulls(sitingContextSchema.parse(row.data));
  }

  // The committed file's order is hand-curated and Neon stores none, so rows
  // are written in operator-name code-unit order (deterministic).
  const ownership = operatorOwnershipFileSchema.parse(ownershipRows.map((r) => r.data)).sort(byOperator);

  const missingSiting = facilities.filter((f) => !Object.hasOwn(siting, f.id)).length;
  if (missingSiting > 0) {
    warn(`export: ${missingSiting} facilities have no siting_context row (expected until a local siting refresh)`);
  }

  const facilityIds = new Set(facilities.map((f) => f.id));
  const orphanSiting = Object.keys(siting).filter((id) => !facilityIds.has(id)).length;
  if (orphanSiting > 0) {
    warn(`export: ${orphanSiting} siting_context rows have no matching facility (exported anyway)`);
  }

  const bodies: Array<[string, string]> = [
    ["facilities.json", json(facilities)],
    ["facilities.meta.json", json(buildExportMeta(facilities.length, readAt))],
    ["siting-context.json", json(siting)],
    ["operator-ownership.json", json(ownership)],
  ];

  return { bodies, facilities, siting, missingSiting, orphanSiting };
}
