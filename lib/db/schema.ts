import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
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
 * promotes it via the `createFacility`/`updateFacility` write
 * primitives, so the same validation and revalidation apply either way.
 *
 * `submissions_status_check` puts the core invariant's staging half —
 * "unreviewed intake is staged, nothing promotes itself" (CLAUDE.md) — into
 * the DATABASE's domain, not only in app code. Before it, `status` was plain
 * `text` with a `'pending'` DEFAULT: every current writer pins `'pending'`
 * explicitly (`createSubmission` in lib/submissions.ts) and a default only
 * applies when the column is OMITTED, so any future writer that passes
 * `status` at all — a new pipeline lane, a hand-written backfill, an ad-hoc
 * Neon INSERT — was accepted by Postgres straight at `'approved'`, bypassing
 * review entirely. The constraint makes the value set enforceable rather than
 * conventional, and also rejects a typo'd `'Approved'`/`'reject'` that would
 * otherwise sit in the queue invisible to every status filter.
 *
 * ⚠️ The literal list here MUST equal `REVIEW_STATUSES` in lib/submissions.ts.
 * It is duplicated, not imported, because lib/submissions.ts imports THIS
 * module — importing back would be a cycle. The duplication is held by a
 * behavioural drift test (lib/db/schema.submissions-status.integration.test.ts)
 * that inserts every `REVIEW_STATUSES` member against a real Postgres and
 * expects each to be accepted, so adding a fourth status without extending
 * the constraint turns that test red instead of failing in production.
 */
export const submissionsTable = pgTable(
  "submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | rejected — enforced by submissions_status_check below
    kind: text("kind").notNull(), // create | update
    targetFacilityId: text("target_facility_id"), // set for kind=update
    payload: jsonb("payload").notNull(), // full Facility doc (create) or partial patch (update)
    provenance: jsonb("provenance").notNull(), // sources/confidence/discoveredBy/runId/discoveredAt
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    index("submissions_status_idx").on(table.status),
    // Serves the lead -> submission link filter in lib/leads.ts (provenance->>'discoveredBy' IN (...)).
    index("submissions_discovered_by_idx").on(sql`(${table.provenance} ->> 'discoveredBy')`),
    check(
      "submissions_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected')`
    ),
  ]
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
    changeType: text("change_type").notNull(), // create | update | delete | editorial
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
    // "facility" and "state" are both LIVE target types, each with its own
    // notify path in lib/notify.ts: notifySubscribersOfChange(s) matches
    // targetType = "facility" only (immediate, per-change), and
    // notifyStateSubscribersMonthly matches targetType = "state" only
    // (batched, monthly digest — see that function's doc comment for the
    // "nothing calls this yet" caveat). "all" is RETIRED, not merely
    // dormant — a closing email went out to its subscribers 2026-09 and all
    // 3 rows are unsubscribed; do not re-enable it as a selectable target.
    // The column stays permissive (plain text, no enum/CHECK) so existing
    // rows of any vintage remain readable/unsubscribable regardless of which
    // target types are currently live.
    targetType: text("target_type").notNull(), // facility | state (retired: all)
    targetId: text("target_id"), // facility id (slug) or 2-letter state code; null only for the retired 'all' target
    status: text("status").notNull().default("pending"), // pending | confirmed | unsubscribed
    confirmToken: text("confirm_token").notNull(), // sha256 hash (64 hex) of the raw 256-bit base64url single-use (double-opt-in) token; raw is shown once to its owner in the confirm email, so a DB leak yields no usable credential — see lib/token-hash.ts
    unsubscribeToken: text("unsubscribe_token").notNull(), // deliberately RAW, not hashed — 256-bit base64url; lib/notify.ts must embed this, readable, in every future alert email, and its leak blast radius is unsubscribe-only, not data access
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  },
  (table) => [
    index("subscriptions_status_idx").on(table.status),
    index("subscriptions_target_idx").on(table.targetType, table.targetId),
    uniqueIndex("subscriptions_confirm_token_idx").on(table.confirmToken),
    uniqueIndex("subscriptions_unsub_token_idx").on(table.unsubscribeToken),
    // Plus a hand-managed PARTIAL UNIQUE index `subscriptions_active_target_idx`
    // in drizzle/0004 (one active sub per email+target; excludes unsubscribed) —
    // not modeled here because Drizzle can't cleanly express the COALESCE/partial
    // predicate, same as the facilities tsvector GIN index. App-code dedup relies
    // on it for a race-free "already subscribed" path.
  ]
);

export type SubscriptionRow = typeof subscriptionsTable.$inferSelect;

/**
 * Durable opt-out list: one row means "never email this address for this
 * target again." `subscriptions.status = 'unsubscribed'` is not durable — the
 * partial unique index excludes it, so a fresh anonymous POST can re-insert
 * the pair and trigger a confirm email.
 *
 * Holds the PLAINTEXT address (stored lowercased + trimmed, same as
 * `subscriptions.email`), by decision (Ed, 2026-10-21): the backfill is one SQL
 * INSERT..SELECT, and a salted hash would break if the salt rotated.
 *
 * `target_type = '' AND target_id = ''` is a GLOBAL opt-out ("stop all
 * email"). Empty string rather than NULL so the plain unique index below makes
 * inserts idempotent via ON CONFLICT DO NOTHING (NULLs never collide).
 * `source`: unsubscribe | unsubscribe_all | backfill | admin.
 *
 * `source_token_hash`: on a GLOBAL row written by "stop all email", the
 * sha256 (lib/token-hash.ts) of the unsubscribe token that stopped it. Only a
 * request presenting that same token may lift the global row (the "Undo"
 * action), so no other token for the address, and no stranger, can. NULL on
 * backfill and admin rows: nothing can lift those through a token. The first
 * stop-all wins (ON CONFLICT DO NOTHING keeps its hash). Never the raw token.
 */
export const emailSuppressionsTable = pgTable(
  "email_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    email: text("email").notNull(),
    targetType: text("target_type").notNull().default(""),
    targetId: text("target_id").notNull().default(""),
    source: text("source").notNull(),
    sourceTokenHash: text("source_token_hash"),
  },
  (table) => [
    uniqueIndex("email_suppressions_email_target_idx").on(
      table.email,
      table.targetType,
      table.targetId
    ),
  ]
);

export type EmailSuppressionRow = typeof emailSuppressionsTable.$inferSelect;

/**
 * One row per request to `POST /api/subscribe` that reaches a branch decision
 * — the counter `checkSubscribeRateLimit` reads.
 *
 * Precisely: written once, before any content-dependent branch, for every
 * request the rate-limit gate admits. Four paths write nothing, and none of
 * them is content-dependent, so none is an oracle: `hashIp` throwing, the gate
 * SELECT throwing, this INSERT throwing (all three answered 503 as the
 * infrastructure failures they are), and the already-refused 429 — which is
 * decided purely by the prior count and is skipped so the rolling window can
 * actually drain for a shared egress IP. See app/api/subscribe/route.ts.
 *
 * WHY IT EXISTS: the subscribe cap used to count `subscriptions` rows, which
 * only a successful INSERT can raise. Every request that terminated without
 * inserting (invalid JSON, Zod failure, honeypot, unknown facility, unknown
 * state, over the per-address send cap, duplicate) was therefore free, and an
 * attacker who never succeeded was never rate-limited at all.
 *
 * WHY A SEPARATE TABLE, NOT A COLUMN: the rows that must be counted are
 * precisely the ones that create no subscription, so there is no subscription
 * row to carry the count. A separate table is also the only shape that lets
 * every branch write *identically* — `subscribeToTarget` deliberately returns
 * the same generic `{ok:true}` for the honeypot / duplicate / over-cap paths
 * (a prior security-review fix), and a side effect that fired on some of those
 * paths but not others would be an observable oracle distinguishing them.
 *
 * WHY ONLY A HASH: the IP is pseudonymized with the same salted sha256 as every
 * other `submitter_ip_hash` in this file (`hashIp`, lib/rate-limit.ts). A raw
 * IP is never stored. Rows are pruned by `scripts/retention-prune.ts`
 * (`SUBSCRIBE_ATTEMPTS_RETENTION_DAYS`) — the cap window is one hour, so they
 * have no useful life beyond it.
 *
 * Carries no email, no target, and no outcome, deliberately: an attempt row
 * must reveal nothing about which branch the request took.
 */
export const subscribeAttemptsTable = pgTable(
  "subscribe_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    submitterIpHash: text("submitter_ip_hash").notNull(),
  },
  (table) => [
    index("subscribe_attempts_ip_created_idx").on(table.submitterIpHash, table.createdAt),
  ]
);

export type SubscribeAttemptRow = typeof subscribeAttemptsTable.$inferSelect;

/**
 * The write surfaces `intake_attempts` counts, one budget each. String
 * literals, not an enum type: adding a surface must not need a migration.
 */
export const INTAKE_SURFACES = [
  "contribute",
  "leads",
  "contact",
  "access-request",
  // Commercial Checkout starts; per-IP, card-testing is the threat (app/api/access/checkout/route.ts).
  "commercial-checkout",
  // Subscription self-service for commercial grant holders; per-IP (reserved for the cancel control).
  "commercial-billing-portal",
  // Failed admin-login attempts only (app/admin/login/actions.ts); own budget, see ADMIN_LOGIN_* in lib/rate-limit.ts.
  "admin-login",
] as const;

export type IntakeSurface = (typeof INTAKE_SURFACES)[number];

/**
 * `subscribe_attempts` (above) generalised to the other four public write
 * surfaces: one row per request to `POST /api/contribute`, `/api/leads`,
 * `/api/contact` or `/api/access/request` that the rate-limit gate admits,
 * written before any content-dependent branch. It is the counter
 * `checkIntakeRateLimit` reads (lib/rate-limit.ts).
 *
 * WHY IT EXISTS: all four caps used to count OUTCOME rows — `submissions`,
 * `leads`, `contact_messages`, `api_access_grants` — which only a successful
 * INSERT can raise. Every request that terminated without inserting was
 * therefore free, so the bots that never insert were the ones never limited.
 * Worst case, measured in review: `POST /api/contribute {"website":"x"}` trips
 * the honeypot, returns 201, writes nothing, and cost zero budget — a bot that
 * trips the honeypot was completely unlimited while one that did not was
 * capped at 5/hour. On `/api/access/request` the free paths were the
 * generic-success ones (honeypot, over the per-address send cap, an existing
 * pending/active grant), i.e. exactly the branches an attacker hits while
 * email-bombing one address. This is the same defect `subscribe_attempts`
 * closed for subscribe in PR #288; it was never carried across.
 *
 * WHY ONE TABLE WITH A `surface` COLUMN, NOT FOUR TABLES: the budgets stay
 * strictly separate — every read filters on `surface` and the composite index
 * below leads with it, so a burst against one surface cannot starve another
 * (the property the four separate per-surface limiters kept separate
 * tables for). What four tables would add is four migrations, four prune
 * steps, and four near-identical copies of this comment: four places for the
 * "record before every branch" contract to drift, for no isolation the
 * `surface` predicate does not already give. A future surface needs one
 * `INTAKE_SURFACES` entry and no DDL.
 *
 * WHY A SEPARATE TABLE, NOT A COLUMN ON EACH OUTCOME TABLE: the rows that must
 * be counted are precisely the ones that create no outcome row, so there is no
 * outcome row to carry the count. It is also the only shape that lets every
 * branch write *identically*, which the routes' generic-success contract
 * requires: `/api/contribute`, `/api/leads` and `/api/contact` answer a tripped
 * honeypot with the same `201 {ok:true}` as a real submission, and
 * `requestAccessGrant` answers honeypot / over-cap / existing-grant with the
 * same `{ok:true}` — a rate-limit side effect that fired on some of those
 * paths but not others would be an observable oracle separating them.
 * (`/api/access/request` no longer creates grants or records attempts, and
 * `requestAccessGrant` has no production caller; this describes the original
 * design.)
 *
 * WHY ONLY A HASH: same salted sha256 as every other `submitter_ip_hash` here
 * (`hashIp`, lib/rate-limit.ts); a raw IP is never stored. Rows are pruned by
 * `scripts/retention-prune.ts` (`INTAKE_ATTEMPTS_RETENTION_DAYS`) — the cap
 * window is one hour, so they have no useful life beyond it.
 *
 * Carries no email, no payload, and no outcome, deliberately: `surface` is the
 * only discriminator, and it is already known to the caller (it chose the
 * endpoint). An attempt row must reveal nothing about which branch the request
 * took once inside that endpoint.
 */
export const intakeAttemptsTable = pgTable(
  "intake_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    surface: text("surface").notNull(), // one of INTAKE_SURFACES
    submitterIpHash: text("submitter_ip_hash").notNull(),
  },
  (table) => [
    // Leads with `surface` because every read is `surface = ? AND ip = ? AND
    // created_at > ?`, and the prune (`created_at < ?`) scans anyway.
    index("intake_attempts_surface_ip_created_idx").on(
      table.surface,
      table.submitterIpHash,
      table.createdAt
    ),
  ]
);

export type IntakeAttemptRow = typeof intakeAttemptsTable.$inferSelect;

/**
 * A one-shot "email me when this is reviewed" request against a single
 * pending `submissions` row — NOT a subscription. A contributor asking to
 * hear back about the submission they just filed has not subscribed to
 * anything: there is no ongoing relationship, no double opt-in, and nothing
 * to unsubscribe from. Modeling this as a `subscriptionsTable` row would hand
 * them an unsubscribe token for a subscription they never made, and would
 * make them visible to `notifySubscribersOfChange` / `notifyStateSubscribersMonthly`
 * (lib/notify.ts), neither of which this request should ever participate in.
 *
 * The row is deleted the moment its one email is sent — and also on review
 * when the send fails, since a request against an already-reviewed
 * submission has nothing left to do either way. This is a single-fire
 * request, not a durable record: nothing reads a `submission_notify_requests`
 * row after its submission has been reviewed.
 *
 * `submissionId` carries no FK constraint, mirroring `facilityHistoryTable`'s
 * loose-coupling convention above (a submission's lifecycle is independent of
 * any row referencing its id). The unique index on `submissionId` makes
 * recording the request idempotent per submission — a second request for the
 * same submission is a no-op, not a second row.
 *
 * Deliberately no token column: a token would imply a link the recipient can
 * act on (confirm, unsubscribe), and there is none here — the row is
 * addressed by `submissionId` alone, written once by the intake, read once by
 * the review path, and deleted right after.
 */
export const submissionNotifyRequestsTable = pgTable(
  "submission_notify_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    submissionId: uuid("submission_id").notNull(),
    email: text("email").notNull(), // stored lowercased + trimmed; deleted immediately after its single send
  },
  (table) => [
    uniqueIndex("submission_notify_submission_idx").on(table.submissionId),
    index("submission_notify_email_created_idx").on(table.email, table.createdAt),
  ]
);

export type SubmissionNotifyRequestRow = typeof submissionNotifyRequestsTable.$inferSelect;

/**
 * WHY THIS EXISTS: `checkSubmissionNotifyCap` (lib/rate-limit.ts) counts
 * `submission_notify_requests` rows, but those rows are deleted the moment
 * their submission is reviewed (see that table's doc comment above) — so it
 * bounds *outstanding* requests per address, not how much mail an address
 * actually receives. One actor can name the same victim address across
 * several submissions from one IP (within the existing per-IP
 * `checkIntakeRateLimit`("contribute") budget) to fill that cap; the maintainer's ordinary review
 * of the queue — approve OR reject, either sends the courtesy email and
 * deletes the row — resets the cap to zero, so the attacker refills
 * immediately and mail volume is unbounded over time, with the maintainer's
 * own spam-cleanup as the delivery mechanism. This table is the persistent
 * counter that closes that hole by surviving the notify-request row's
 * deletion.
 *
 * WHY A HASH, NOT THE ADDRESS: the entire point of `submission_notify_requests`
 * is that the address is discarded after its one use; a counter holding raw
 * addresses would silently reintroduce exactly the retention that design
 * avoids. `hashNotifyEmail` (lib/rate-limit.ts) salts and hashes the address
 * the same way every `submitter_ip_hash` in this file pseudonymizes an IP —
 * countable without being retained.
 *
 * WHY A SEPARATE TABLE, NOT A COLUMN: the rows that must be counted are
 * precisely the ones whose `submission_notify_requests` row is being
 * deleted — so by the time there's something to count against, there is
 * nothing left on that row to carry the count.
 *
 * WHY ATTEMPTS, NOT SUCCESSFUL SENDS: same reasoning as `subscribeAttemptsTable`
 * above (PR #288) — a counter that only increments on send *success* is free
 * to anyone whose send never succeeds. This table is written before the send
 * is attempted, not after it succeeds (see `recordSubmissionNotifySend` /
 * `lib/submissions.ts`'s `notifySubmitterOfReview`), so a failing send still
 * spends the target address's budget.
 *
 * Rows are pruned by `scripts/retention-prune.ts`
 * (`SUBMISSION_NOTIFY_SENDS_RETENTION_DAYS`), set comfortably beyond the cap
 * window so pruning can never shorten it.
 */
export const submissionNotifySendsTable = pgTable(
  "submission_notify_sends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    emailHash: text("email_hash").notNull(),
  },
  (table) => [
    index("submission_notify_sends_hash_created_idx").on(table.emailHash, table.createdAt),
  ]
);

export type SubmissionNotifySendRow = typeof submissionNotifySendsTable.$inferSelect;

/**
 * The send ledger that makes the monthly state digest idempotent (Theme D,
 * D3). One row per `(since, until)` window `notifyStateSubscribersMonthly`
 * has been asked to run — see `lib/state-digest-ledger.ts`'s
 * `claimDigestWindow`/`completeDigestWindow`, the only functions that write
 * this table.
 *
 * WHAT IT IS: A CLAIM, NOT A LOG. The row is inserted BEFORE any change is
 * built or any mail is sent — `claimDigestWindow` INSERTs first, and it is
 * the unique index below, not any application-level check, that makes a
 * repeat call for the same window a no-op. A row written AFTER a successful
 * send (a log) would not help at all: the exact failure this must survive is
 * a run that dies mid-loop, which writes no completion record under a
 * log-after design either — and whose retry would then re-mail everyone the
 * dead run already reached.
 *
 * `completedAt IS NULL` on a row therefore means CLAIMED BUT NEVER FINISHED —
 * a crashed or timed-out run, not a clean send. A human should look at a row
 * in that state before assuming its month went out; `notifyStateSubscribersMonthly`
 * and the cron route both surface this distinction rather than collapsing it
 * into an ordinary "already sent."
 *
 * THE CHOSEN FAILURE DIRECTION, stated plainly: a crashed run's window stays
 * claimed, so whichever recipients it had not yet reached when it died are
 * never mailed by a later retry. That is deliberate — silent under-delivery
 * to a handful of people is preferred over duplicate-mailing real people,
 * which is the failure this table exists to prevent. Per-recipient delivery
 * tracking is the real fix for the partial-failure case and is explicitly
 * NOT what this table does.
 *
 * ⛔ NEVER add this table to `scripts/retention-prune.ts`. Pruning a row
 * silently re-arms duplicate sends for whatever window ages out — the exact
 * failure this table exists to prevent, reintroduced by its own cleanup. The
 * rows carry no PII (two timestamps and three counts) and accrue about
 * twelve a year, so there is nothing to reclaim by pruning them. This is the
 * single most likely "helpful" future edit to get wrong.
 *
 * No `state` column, deliberately: the window is global, not per-state. One
 * claimed run covers every state in a single pass; `sendGroupedChangeNotifications`
 * fans out per (email, state) inside it, same as before this table existed.
 */
export const stateDigestRunsTable = pgTable(
  "state_digest_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    since: timestamp("since", { withTimezone: true }).notNull(),
    until: timestamp("until", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    changes: integer("changes"),
    groups: integer("groups"),
    recipients: integer("recipients"),
  },
  (table) => [uniqueIndex("state_digest_runs_window_idx").on(table.since, table.until)]
);

export type StateDigestRunRow = typeof stateDigestRunsTable.$inferSelect;

/**
 * One row per outbound subscription email attempt (A-3 accountability log):
 * who-hash, which kind, which subscription/run, and how it ended.
 * `lib/email-sends.ts` is the only writer.
 *
 * WRITTEN BEFORE THE SEND: `recordSendAttempt` inserts an `attempted` row
 * first and `completeSend` settles it afterwards. A row still `attempted`
 * with a NULL `completed_at` is a send whose outcome was never recorded (a
 * crash or timeout between the provider call and the UPDATE), not a clean
 * send.
 *
 * NEVER STORES the subject, the body, the plaintext address, or a raw
 * provider error. `email_hash` is the salted `hashNotifyEmail` digest;
 * `error_code` is an identifier from `safeErrorCode`, never free text.
 *
 * NOT A DEDUPE LEDGER. Never use it for at-most-once delivery: a failed
 * insert, a pruned row or a retried send all leave it silent. At-most-once
 * for the monthly digest is `state_digest_runs`' unique window claim.
 *
 * The ONLY counting reader is the 30-day per-address confirm cap
 * (`countRecentConfirmSends`). Its window must stay well inside the
 * retention in `scripts/retention-prune.ts` (`EMAIL_SENDS_RETENTION_DAYS`,
 * 180 days), so pruning can never shorten the cap; a test pins the ratio.
 *
 * `subscription_id` and `run_id` are ON DELETE SET NULL: deleting a
 * subscription (retention-prune removes unsubscribed rows after 30 days) or
 * a digest run must not delete the log row that records what was mailed.
 *
 * `kind`: confirm | watch_started | facility_change | facility_digest |
 * state_digest | area_digest. `outcome`: attempted | sent | error |
 * skipped_no_key | skipped_suppressed | skipped_check_failed |
 * skipped_unconfirmed | skipped_capped | skipped_duplicate.
 * Both are validated at the type level only (no CHECK constraint), so a new
 * value needs no migration.
 */
export const emailSendsTable = pgTable(
  "email_sends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    kind: text("kind").notNull(),
    emailHash: text("email_hash").notNull(),
    subscriptionId: uuid("subscription_id").references(() => subscriptionsTable.id, {
      onDelete: "set null",
    }),
    targetType: text("target_type"),
    targetId: text("target_id"),
    runId: uuid("run_id").references(() => stateDigestRunsTable.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull().default("attempted"),
    resendId: text("resend_id"),
    errorCode: text("error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("email_sends_hash_created_idx").on(table.emailHash, table.createdAt),
    index("email_sends_subscription_idx").on(table.subscriptionId),
    index("email_sends_run_idx").on(table.runId),
    index("email_sends_created_idx").on(table.createdAt),
  ]
);

export type EmailSendRow = typeof emailSendsTable.$inferSelect;

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
    // Plain text, deliberately not a Postgres enum or CHECK: LEAD_STATUSES
    // (lib/lead-fields.ts) is the single source of truth and `updateLeadStatus`
    // validates against it, so adding a status is a code-only change.
    status: text("status").notNull().default("new"), // new | researching | deferred | promoted | dismissed
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

/**
 * The public contact channel (`POST /api/contact`) — press/research/
 * partnership/correction/other inquiries addressed to the maintainer. This is
 * NOT a data intake: nothing here ever becomes a facility, a submission, or a
 * lead, and no code path reads this table to influence live data. Facility
 * tips stay on `/contribute` and `/api/leads`.
 *
 * Rows are stored (not just emailed) for two reasons: (1) durable per-IP rate
 * limiting — an in-memory limiter is per-lambda on serverless and therefore
 * near-useless across invocations, so `submitterIpHash` needs a real table to
 * count against, same as `leadsTable`; (2) so a Resend failure never loses
 * correspondence — `emailSent` records whether the notification actually went
 * out, independent of whether the message itself was durably captured.
 */
export const contactMessagesTable = pgTable(
  "contact_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    topic: text("topic").notNull(), // press | research | partnership | correction | other
    message: text("message").notNull(),
    submitterIpHash: text("submitter_ip_hash"), // for rate limiting
    emailSent: boolean("email_sent").notNull().default(false),
  },
  (table) => [
    index("contact_messages_created_at_idx").on(table.createdAt.desc()),
    index("contact_messages_submitter_ip_hash_idx").on(table.submitterIpHash),
  ]
);

export type ContactMessageRow = typeof contactMessagesTable.$inferSelect;

/**
 * Email-verified, revocable grant of a higher API request ceiling — NOT a
 * user account. `confirmToken` is the one-time magic-link token, `accessToken`
 * is the long-lived bearer credential minted only once, on confirm — both are
 * stored as a sha256 hash of their raw value (see the per-column comments
 * below and lib/token-hash.ts), same convention as `subscriptionsTable.confirmToken`
 * above. This table is self-contained (schema + email + request/confirm
 * routes) — nothing outside this file's Unit reads `accessToken` yet; wiring
 * it into the actual `/api/facilities`-family rate gate is a separate unit,
 * done below in `apiDailyUsageTable`.
 */
export const apiAccessGrantsTable = pgTable(
  "api_access_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    email: text("email").notNull(), // stored lowercased + trimmed
    status: text("status").notNull().default("pending"), // pending | active | revoked
    confirmToken: text("confirm_token").notNull(), // sha256 hash (64 hex) of the raw 256-bit base64url single-use magic-link token; raw shown once to its owner — see lib/token-hash.ts
    accessToken: text("access_token"), // sha256 hash (64 hex) of the raw 256-bit base64url bearer token; set on confirm, null until active; raw shown once to its owner — see lib/token-hash.ts
    submitterIpHash: text("submitter_ip_hash"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // confirmedAt + 90 days
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    requestCount: integer("request_count").notNull().default(0), // usage counter, visibility only for now
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    index("api_access_grants_status_idx").on(table.status),
    uniqueIndex("api_access_grants_confirm_token_idx").on(table.confirmToken),
    uniqueIndex("api_access_grants_access_token_idx").on(table.accessToken),
    index("api_access_grants_ip_idx").on(table.submitterIpHash),
  ]
);

export type ApiAccessGrantRow = typeof apiAccessGrantsTable.$inferSelect;

/**
 * Vocabularies for the approved-access dataset-sharing tables below. String
 * literals in plain text columns, not pg enums or CHECK constraints: adding a
 * value must not need a migration (same call as INTAKE_SURFACES above).
 */
export const DATASET_GRANT_STATUSES = [
  "unverified",
  "pending_review",
  "active",
  "expired",
  "revoked",
  "rejected",
] as const;

export type DatasetGrantStatus = (typeof DATASET_GRANT_STATUSES)[number];

/**
 * Statuses that count as an OPEN grant for an email and tier: the single source for the predicate of the partial
 * unique index `dataset_access_grants_open_email_tier_idx` below and for the matching `ON CONFLICT ... WHERE`
 * target in lib/dataset-grants.ts. Changing it changes the index, so it needs a migration.
 */
export const DATASET_OPEN_GRANT_STATUSES = [
  "unverified",
  "pending_review",
  "active",
] as const satisfies readonly DatasetGrantStatus[];

export const DATASET_CATEGORIES = [
  "journalist",
  "academic",
  "nonprofit",
  "government",
  "commercial",
  "other",
] as const;

export type DatasetCategory = (typeof DATASET_CATEGORIES)[number];

export const DATASET_TIERS = ["free", "commercial"] as const;

export type DatasetTier = (typeof DATASET_TIERS)[number];

export const DATASET_EDITION_STATUSES = ["building", "published", "failed"] as const;

export type DatasetEditionStatus = (typeof DATASET_EDITION_STATUSES)[number];

export const DATASET_DOWNLOAD_OUTCOMES = ["served", "denied_rate", "error"] as const;

export type DatasetDownloadOutcome = (typeof DATASET_DOWNLOAD_OUTCOMES)[number];

/**
 * A requester's approved-access grant to the weekly dataset editions — NOT a
 * user account. Lifecycle: `unverified` (request made, email not yet proven)
 * -> `pending_review` (email verified, awaiting the maintainer) -> `active`
 * (approved; `accessTokenHash` set) -> `expired` / `revoked`, or `rejected`
 * from review. The row also carries the request itself (who, why, the
 * attribution acknowledgement and the terms version it was made against), so
 * the maintainer reviews from this one table.
 *
 * Every token column stores ONLY a sha256 hash of the raw token (see
 * lib/token-hash.ts); the raw access/verify/renew tokens are shown once to
 * their owner and must never be stored. The one exception is `unsubscribeToken`,
 * kept raw by the `subscriptionsTable` precedent: its blast radius is
 * unsubscribing the one grant from the weekly notice, nothing else. It is minted
 * on approval and is null until then. The weekly-notice sender (lib/dataset-notices.ts)
 * mails only active grants whose `expiresAt` is set and later than now();
 * see the `lastNoticeEditionId` contract below.
 *
 * Deliberately separate from `apiAccessGrantsTable`: lib/api-daily-limit.ts
 * honors an active `api_access_grants` bearer to raise the public API
 * ceilings, and a dataset token must never do that.
 *
 * At most one OPEN (`unverified` | `pending_review` | `active`) row may exist
 * per (email, tier), enforced by the partial unique index
 * `dataset_access_grants_open_email_tier_idx`; that is what gives the request path
 * (lib/dataset-grants.ts) a race-free dedupe. Rows that are `expired`,
 * `revoked` or `rejected` do not count, so a re-request inserts a new row.
 *
 * `lastNoticeEditionId` is the authoritative per-grant weekly-notice marker.
 * It remembers only the LAST edition claimed, so this is the CONTRACT the
 * sender (lib/dataset-notices.ts `sendEditionNotices`, run by the edition
 * build) meets: claim first, and mail only if a row came back, with
 *   UPDATE dataset_access_grants SET last_notice_edition_id = $e
 *   WHERE id = $g AND status = 'active' AND expires_at > now()
 *     AND last_notice_edition_id IS DISTINCT FROM $e
 *     AND $e = (SELECT id FROM dataset_editions WHERE status = 'published'
 *               ORDER BY edition_date DESC LIMIT 1)
 *   RETURNING id
 * The newest-edition predicate is what makes it at-most-once: claiming an
 * older edition after a newer one would otherwise re-claim and re-mail it.
 * Under that contract, and while a published edition is never un-published, a
 * grant is mailed each edition's notice at most once. Claim-before-send means a
 * send that fails after its claim is not retried for that (grant, edition): the
 * grant misses that week's notice instead. `dataset_editions.notice_sent_at`
 * is only the edition-level marker (see there). It has NO foreign key to
 * `dataset_editions` on purpose: it is a claim marker, not a relation, and an
 * FK would force a drop order on rollback and block pruning old editions.
 *
 * Rollback (children first): DROP TABLE dataset_downloads; DROP TABLE
 * dataset_editions; DROP TABLE dataset_access_grants;
 */
export const datasetAccessGrantsTable = pgTable(
  "dataset_access_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    email: text("email").notNull(), // stored lowercased + trimmed
    name: text("name").notNull(),
    organization: text("organization"),
    role: text("role"),
    category: text("category").$type<DatasetCategory>().notNull(), // journalist | academic | nonprofit | government | commercial | other
    intendedUse: text("intended_use").notNull(),
    links: jsonb("links").$type<string[]>().notNull().default([]), // requester-supplied supporting URLs
    attributionAckAt: timestamp("attribution_ack_at", { withTimezone: true }).notNull(),
    termsVersion: text("terms_version").notNull(), // the terms the requester acknowledged
    status: text("status").$type<DatasetGrantStatus>().notNull().default("unverified"), // unverified | pending_review | active | expired | revoked | rejected
    verifyTokenHash: text("verify_token_hash").notNull(), // sha256 hash (64 hex) of the raw single-use email-verification token — see lib/token-hash.ts
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    accessTokenHash: text("access_token_hash"), // sha256 hash (64 hex) of the raw bearer token; set on approval, null until active — see lib/token-hash.ts
    renewTokenHash: text("renew_token_hash"), // sha256 hash (64 hex) of the raw renewal-link token — see lib/token-hash.ts
    unsubscribeToken: text("unsubscribe_token"), // RAW by the subscriptions precedent: unsubscribe-only blast radius
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    rejectionNote: text("rejection_note"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    renewalRemindedAt: timestamp("renewal_reminded_at", { withTimezone: true }),
    renewalRequestedAt: timestamp("renewal_requested_at", { withTimezone: true }),
    lastDownloadAt: timestamp("last_download_at", { withTimezone: true }),
    lastNoticeEditionId: uuid("last_notice_edition_id"), // newest-edition weekly-notice claim (contract in the table doc); deliberately NO foreign key
    downloadCount: integer("download_count").notNull().default(0),
    submitterIpHash: text("submitter_ip_hash"),
    tier: text("tier").$type<DatasetTier>().notNull().default("free"), // free | commercial; a commercial grant is live only while paid_through is in the future (liveGrant)
    paidThrough: timestamp("paid_through", { withTimezone: true }), // set by the PayPal webhook; null until first payment
    paypalSubscriptionId: text("paypal_subscription_id"),
    payerIdHash: text("payer_id_hash"), // sha256 (lib/token-hash.ts) of the buyer's PayPal payer_id; matches a revoked buyer who returns under a new email. NEVER the raw payer id.
  },
  (table) => [
    index("dataset_access_grants_status_idx").on(table.status),
    uniqueIndex("dataset_access_grants_paypal_subscription_id_idx").on(table.paypalSubscriptionId),
    index("dataset_access_grants_email_idx").on(table.email),
    index("dataset_access_grants_payer_id_hash_idx").on(table.payerIdHash),
    // One open row per (email, tier): a free and a commercial grant may coexist for one address, but never
    // two of the same tier. The tier split is what keeps a purchase (whose Checkout email nobody has
    // verified) from ever touching somebody's free request.
    uniqueIndex("dataset_access_grants_open_email_tier_idx")
      .on(table.email, table.tier)
      // `sql.raw` over the constant's quoted literals (fixed values in this file, never input): the index
      // predicate must be literal text, and this emits the same SQL as the migration's hand-readable form.
      .where(sql`${table.status} in (${sql.raw(DATASET_OPEN_GRANT_STATUSES.map((status) => `'${status}'`).join(", "))})`),
    index("dataset_access_grants_expires_at_idx").on(table.expiresAt),
    uniqueIndex("dataset_access_grants_verify_token_hash_idx").on(table.verifyTokenHash),
    uniqueIndex("dataset_access_grants_access_token_hash_idx").on(table.accessTokenHash),
    uniqueIndex("dataset_access_grants_renew_token_hash_idx").on(table.renewTokenHash),
    uniqueIndex("dataset_access_grants_unsubscribe_token_idx").on(table.unsubscribeToken),
    check("dataset_access_grants_tier_check", sql`${table.tier} IN ('free', 'commercial')`),
  ]
);

export type DatasetAccessGrantRow = typeof datasetAccessGrantsTable.$inferSelect;

/** One file inside a built dataset edition, as recorded in `dataset_editions.files`. */
export interface DatasetEditionFile {
  name: string;
  pathname: string;
  bytes: number;
  sha256: string;
}

/**
 * One weekly dataset build. `editionDate` is a plain "YYYY-MM-DD" string,
 * unique, matching `apiDailyUsageTable.day` (this file's date-only-as-text
 * convention). `status` runs `building` -> `published` | `failed`. `files`
 * records what was built (name, storage pathname, size, sha256). `noticeSentAt`
 * must be set only after the send loop has claimed, and attempted to mail,
 * every active, unexpired grant for this edition (`lastNoticeEditionId` on the
 * grants table is the authoritative per-grant marker). A partial run leaves it
 * null. A rerun completes the edition only while it is still the newest
 * published edition; after a newer edition publishes, the rerun claims
 * nothing, so grants it had not yet claimed miss this edition's notice.
 */
export const datasetEditionsTable = pgTable(
  "dataset_editions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    editionDate: text("edition_date").notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").$type<DatasetEditionStatus>().notNull().default("building"), // building | published | failed
    recordCount: integer("record_count"),
    files: jsonb("files").$type<DatasetEditionFile[]>().notNull().default([]),
    changelogSummary: jsonb("changelog_summary"), // opaque summary of what changed vs the previous edition
    noticeSentAt: timestamp("notice_sent_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("dataset_editions_edition_date_idx").on(table.editionDate)]
);

export type DatasetEditionRow = typeof datasetEditionsTable.$inferSelect;

/**
 * Log of dataset download attempts by an ACTIVE, unexpired grant: one row per
 * attempt, including rate-limit denials and errors (`outcome`). Attempts that
 * do not resolve to an active, unexpired grant (unknown, malformed or revoked
 * token; expired, pending or rejected grant) are NOT logged here, so that
 * unauthenticated requests never write rows; the download route must bound
 * them with a per-IP rate limit applied before the token lookup. Deleting a
 * grant deletes its rows (cascade); deleting an edition keeps them and nulls
 * `editionId` (set null). The IP is stored only as a hash, never raw.
 */
export const datasetDownloadsTable = pgTable(
  "dataset_downloads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => datasetAccessGrantsTable.id, { onDelete: "cascade" }),
    editionId: uuid("edition_id").references(() => datasetEditionsTable.id, { onDelete: "set null" }),
    file: text("file").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    ipHash: text("ip_hash"),
    outcome: text("outcome").$type<DatasetDownloadOutcome>().notNull(), // served | denied_rate | error
  },
  (table) => [
    index("dataset_downloads_grant_created_idx").on(table.grantId, table.createdAt.desc()),
    index("dataset_downloads_edition_idx").on(table.editionId),
    index("dataset_downloads_created_idx").on(table.createdAt),
  ]
);

export type DatasetDownloadRow = typeof datasetDownloadsTable.$inferSelect;

/**
 * Idempotency log of PayPal webhook events: `id` is the PayPal event id, so a
 * redelivered event hits the primary key. `processedAt` is null until the
 * handler finishes. Deleting a grant keeps the row and nulls `grantId`.
 */
export const paypalWebhookEventsTable = pgTable(
  "paypal_webhook_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    grantId: uuid("grant_id").references(() => datasetAccessGrantsTable.id, { onDelete: "set null" }),
  },
  (table) => [index("paypal_webhook_events_received_at_idx").on(table.receivedAt)]
);

export type PaypalWebhookEventRow = typeof paypalWebhookEventsTable.$inferSelect;

/**
 * One row per commercial checkout attempt, created by our own form BEFORE the buyer is sent to PayPal; its
 * `id` travels to PayPal as `custom_id`, which is how the webhook finds the attempt again. `decision` stays
 * null until the webhook evaluates the subscription: 'activate' (it gets, or already has, a grant) or
 * 'refuse' (cancel + refund). A refusal always has a `reason`, and only a refusal does (CHECK). `email`,
 * `name` and `organization` are nullable so retention can scrub them: abandoned attempts (no decision) are
 * deleted after 30 days, decided rows have the three fields nulled after 365 days. `grantId` is the grant this
 * attempt activated, `conflictGrantId` the grant a refusal names; both are informational and null after the
 * grant is deleted. `refundedSaleId` records the PayPal sale refunded on a refusal.
 */
export const commercialCheckoutsTable = pgTable(
  "commercial_checkouts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    plan: text("plan").notNull().$type<"monthly" | "annual">(),
    email: text("email"),
    name: text("name"),
    organization: text("organization"),
    termsVersion: text("terms_version").notNull(),
    paypalSubscriptionId: text("paypal_subscription_id").unique(),
    decision: text("decision").$type<"activate" | "refuse">(),
    reason: text("reason").$type<"already_subscribed" | "revoked_buyer">(),
    grantId: uuid("grant_id").references(() => datasetAccessGrantsTable.id, { onDelete: "set null" }),
    conflictGrantId: uuid("conflict_grant_id").references(() => datasetAccessGrantsTable.id, { onDelete: "set null" }),
    refundedSaleId: text("refunded_sale_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    check("commercial_checkouts_plan_check", sql`${table.plan} IN ('monthly', 'annual')`),
    check("commercial_checkouts_decision_check", sql`${table.decision} IN ('activate', 'refuse')`),
    // A refusal always names its reason, and only a refusal has one (a null decision implies a null reason).
    check(
      "commercial_checkouts_reason_check",
      sql`(${table.decision} IS NOT DISTINCT FROM 'refuse') = (${table.reason} IS NOT NULL)`
    ),
    index("commercial_checkouts_created_at_idx").on(table.createdAt),
  ]
);

export type CommercialCheckoutRow = typeof commercialCheckoutsTable.$inferSelect;

/**
 * Durable per-IP daily request counter for the public facilities-family read
 * API (`GET /api/facilities`, `/api/search`, `/api/stats`, `/api/schema`)
 * and the gate on `/api/facilities/[id]` (admin-bearer only now, but the
 * daily gate still runs before auth) — the anonymous daily ceiling. One row per
 * (ipHash, UTC calendar day), incremented atomically via upsert. This is
 * deliberately separate from `lib/api-rate-limit.ts`'s in-memory burst
 * limiter (60/min): that one resets on cold start and can't hold a day-long
 * sum. `day` is a plain "YYYY-MM-DD" string, matching this file's existing
 * convention of storing simple date-only values as text rather than a
 * Postgres date/timestamp type (see `facilitiesTable.lastUpdated`).
 */
export const apiDailyUsageTable = pgTable(
  "api_daily_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ipHash: text("ip_hash").notNull(),
    day: text("day").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("api_daily_usage_ip_hash_day_idx").on(table.ipHash, table.day),
  ]
);

export type ApiDailyUsageRow = typeof apiDailyUsageTable.$inferSelect;

/**
 * Single-row heartbeat published by the LOCAL discovery pipeline
 * (`scripts/discovery/run.sh`, via `scripts/discovery/publish-heartbeat.ts`)
 * after every run. This table exists solely because the pipeline's actual
 * failure mode is "launchd never fired at all" — `run.sh` already writes a
 * heartbeat to the gitignored `discovery-logs/heartbeat.json` on the
 * maintainer's Mac, but that file is invisible to anything off-machine.
 * Neon is the one place both the Mac (via `.env.local`) and a GitHub Actions
 * watchdog (via a repo secret) can both reach, so publishing the heartbeat
 * here is what lets an external, always-on process detect "no run happened"
 * rather than only "a run happened and failed" (which `run.sh` already
 * self-detects and cannot escalate off-machine).
 *
 * `id` is always the literal `"singleton"` — there is exactly one row,
 * upserted in place, not a history table. `states` mirrors the per-state
 * array from `heartbeat.json` (`runId`/`state`/`claudeStatus`/`elapsedSecs`)
 * as opaque JSON; nothing here re-validates its shape.
 */
export const discoveryHeartbeatTable = pgTable("discovery_heartbeat", {
  id: text("id").primaryKey(), // constant "singleton" — one row, upserted
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(), // "ok" | "degraded"
  failureCount: integer("failure_count").notNull().default(0),
  states: jsonb("states"), // per-state array from heartbeat.json, opaque
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DiscoveryHeartbeatRow = typeof discoveryHeartbeatTable.$inferSelect;

/**
 * Closed-data tables (open-code/closed-data refactor): the curated datasets that
 * used to ship as repo JSON now live in Neon. All three are keyed JSON blobs,
 * written only by maintainer scripts (`backfill:siting`, `ownership:apply`,
 * `siting:apply`, `nhd:debt --ledger-db`). No public path WRITES them. The app reads
 * `siting_context` (lib/siting-context.ts) and `operator_ownership`
 * (lib/operator-ownership.ts) server-side only, falling back to the bundled JSON.
 * The row shape inside `data` is validated by the reader, not the database.
 */

/** Per-facility siting context. `facility_id` matches `facilities.id`; orphans are allowed (retired facilities). */
export const sitingContextTable = pgTable("siting_context", {
  facilityId: text("facility_id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Operator-level ownership. `operator_key` is the EXACT `facility.operator` string, no normalisation. */
export const operatorOwnershipTable = pgTable("operator_ownership", {
  operatorKey: text("operator_key").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Small keyed maintenance state, e.g. `nhd_backfill_debt` -> `{ceiling, asOf, note}`. */
export const maintenanceLedgerTable = pgTable("maintenance_ledger", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
