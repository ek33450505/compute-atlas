import {
  customType,
  index,
  jsonb,
  pgTable,
  text,
  doublePrecision,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { Facility } from "@/lib/schema";
import type { DiffEntry } from "@/lib/doc-diff";
import type { LeadTriage } from "@/lib/leads";

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
    // Scope is intentionally name + operator + notes only — city/county are
    // NOT indexed (a possible future migration), so location search staying
    // out of full-text is a documented decision, not an oversight.
    // WARNING: this shim keeps schema.ts and the drizzle snapshot in
    // agreement on column existence — removing it makes `drizzle-kit
    // generate` emit a destructive `DROP COLUMN search_vector`. Relatedly,
    // `facilities_search_vector_idx` (GIN, on this column) and
    // `subscriptions_active_target_idx` (partial-unique, in the
    // subscriptions table below) are hand-managed and not Drizzle-modeled —
    // any future `drizzle-kit generate` regenerate must be hand-audited
    // before apply so it doesn't try to drop either of them.
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

export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    email: text("email").notNull(), // stored lowercased + trimmed
    // "facility" is the only type accepted for NEW subscriptions. Legacy rows may
    // still hold "state" or "all"; those are inert — lib/notify.ts matches on
    // targetType = "facility" only, so they are never selected for delivery.
    // The column stays permissive so existing rows remain readable/unsubscribable.
    targetType: text("target_type").notNull(), // facility (legacy: state | all)
    targetId: text("target_id"), // facility id (slug); legacy: 2-letter state code, or null for 'all'
    status: text("status").notNull().default("pending"), // pending | confirmed | unsubscribed
    confirmToken: text("confirm_token").notNull(), // raw 256-bit base64url, single-use (double-opt-in)
    unsubscribeToken: text("unsubscribe_token").notNull(), // raw 256-bit base64url, embedded in every email
    submitterIpHash: text("submitter_ip_hash"), // for subscribe rate-limiting
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  },
  (table) => [
    index("subscriptions_status_idx").on(table.status),
    index("subscriptions_target_idx").on(table.targetType, table.targetId),
    uniqueIndex("subscriptions_confirm_token_idx").on(table.confirmToken),
    uniqueIndex("subscriptions_unsub_token_idx").on(table.unsubscribeToken),
    index("subscriptions_ip_idx").on(table.submitterIpHash),
    // Plus a hand-managed PARTIAL UNIQUE index `subscriptions_active_target_idx`
    // in drizzle/0004 (one active sub per email+target; excludes unsubscribed) —
    // not modeled here because Drizzle can't cleanly express the COALESCE/partial
    // predicate, same as the facilities tsvector GIN index. App-code dedup relies
    // on it for a race-free "already subscribed" path.
  ]
);

export type SubscriptionRow = typeof subscriptionsTable.$inferSelect;

/**
 * Unstructured research inbox for bare tips — a URL and an optional one-line
 * note, submitted anonymously by the public. A lead is NOT a facility and NOT
 * a submission: it carries no facility payload, and nothing in
 * lib/facility-write.ts or lib/submissions.ts ever reads this table. A lead
 * can only reach a live facility by first being promoted into a `submissions`
 * row (see `promotedSubmissionId` below), which then goes through the
 * existing human approve gate — there is no direct path.
 */
export const leadsTable = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    url: text("url").notNull(), // the tip itself; the only required user input
    note: text("note"), // optional one-line what/where
    attribution: text("attribution"), // optional public handle
    submitterIpHash: text("submitter_ip_hash"), // for lead rate-limiting
    status: text("status").notNull().default("new"), // new | researching | promoted | dismissed
    triage: jsonb("triage").$type<LeadTriage>(), // submit-time server-side fetch result; null until set
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Set when this lead is promoted into a submissions row. Deliberately no
    // FK constraint, mirroring facilityHistoryTable.facilityId's loose coupling.
    promotedSubmissionId: uuid("promoted_submission_id"),
  },
  (table) => [
    index("leads_status_idx").on(table.status),
    index("leads_created_at_idx").on(table.createdAt.desc()),
    index("leads_submitter_ip_hash_idx").on(table.submitterIpHash),
  ]
);

export type LeadRow = typeof leadsTable.$inferSelect;
