import { customType, index, jsonb, pgTable, text, doublePrecision, timestamp, uuid } from "drizzle-orm/pg-core";

import type { Facility } from "@/lib/schema";
import type { DiffEntry } from "@/lib/doc-diff";

/**
 * `pg-core` has no first-class `tsvector` column type, so this is a minimal
 * custom type solely for query-builder awareness of `facilities.search_vector`
 * (e.g. so `sql` template queries referencing `facilitiesTable.searchVector`
 * resolve to the right column name). It does NOT define how the column's
 * value is computed — that's the hand-written `GENERATED ALWAYS AS (...)
 * STORED` expression in drizzle/0003_facilities_search_vector.sql, which
 * `drizzle-kit generate` cannot model. This type is read-oriented; nothing in
 * this codebase writes to `search_vector` directly (Postgres computes it).
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const facilitiesTable = pgTable(
  "facilities",
  {
    id: text("id").primaryKey(),
    doc: jsonb("doc").$type<Facility>().notNull(),
    name: text("name").notNull(),
    operator: text("operator").notNull(),
    state: text("state").notNull(),
    status: text("status").notNull(),
    facilityType: text("facility_type").notNull(),
    confidence: text("confidence").notNull(),
    capacityOperationalMw: doublePrecision("capacity_operational_mw"),
    capacityPlannedMw: doublePrecision("capacity_planned_mw"),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    announcedDate: text("announced_date"),
    lastUpdated: text("last_updated").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // Generated column — see drizzle/0003_facilities_search_vector.sql and the
    // `tsvector` custom type comment above. Never set/updated by application
    // code (Postgres computes it from name/operator/doc->>'notes' on write).
    searchVector: tsvector("search_vector"),
  },
  (table) => [
    index("facilities_state_idx").on(table.state),
    index("facilities_operator_idx").on(table.operator),
    index("facilities_status_idx").on(table.status),
    index("facilities_facility_type_idx").on(table.facilityType),
  ]
);

export type FacilityRow = typeof facilitiesTable.$inferSelect;

/**
 * Staging queue for discovered/submitted facility candidates. A submission
 * is either a `create` (payload is a full Facility doc) or an `update`
 * (payload is a partial patch against `targetFacilityId`) — approving one
 * promotes it via the Phase 3 `createFacility`/`updateFacility` write
 * primitives, so the same validation and revalidation apply either way.
 */
export const submissionsTable = pgTable(
  "submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | rejected
    kind: text("kind").notNull(), // create | update
    targetFacilityId: text("target_facility_id"), // set for kind=update
    payload: jsonb("payload").notNull(), // full Facility doc (create) or partial patch (update)
    provenance: jsonb("provenance").notNull(), // sources/confidence/discoveredBy/runId/discoveredAt
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [index("submissions_status_idx").on(table.status)]
);

export type SubmissionRow = typeof submissionsTable.$inferSelect;

/**
 * Audit trail for facility mutations. Stores a COMPUTED diff (`DiffEntry[]`,
 * see `lib/doc-diff.ts`) rather than two full before/after doc columns — the
 * diff is computed once at write time by the `lib/facility-write.ts`
 * primitives and persisted as-is; nothing re-diffs on read.
 *
 * `facilityId` intentionally carries no hard FK constraint, mirroring the
 * repo's loose-coupling style around the `doc`-jsonb id lifecycle (a facility
 * row can be deleted while its history remains as a record of what existed).
 */
export const facilityHistoryTable = pgTable(
  "facility_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: text("facility_id").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    changeType: text("change_type").notNull(), // create | update | delete
    diff: jsonb("diff").$type<DiffEntry[]>().notNull(),
    source: text("source").notNull(), // "admin-direct" or a submission id
  },
  (table) => [
    index("facility_history_facility_id_changed_at_idx").on(
      table.facilityId,
      table.changedAt.desc()
    ),
  ]
);

export type FacilityHistoryRow = typeof facilityHistoryTable.$inferSelect;
