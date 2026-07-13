import { index, jsonb, pgTable, text, doublePrecision, timestamp, uuid } from "drizzle-orm/pg-core";

import type { Facility } from "@/lib/schema";

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
