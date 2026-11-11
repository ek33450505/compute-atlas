// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("../lib/db/client");

import * as dbClient from "../lib/db/client";
import { makeTestDb, type TestDbHandle } from "../test/pglite-db";
import {
  apiAccessGrantsTable,
  apiDailyUsageTable,
  contactMessagesTable,
  commercialCheckoutsTable,
  datasetAccessGrantsTable,
  datasetDownloadsTable,
  intakeAttemptsTable,
  leadsTable,
  submissionsTable,
  submissionNotifyRequestsTable,
  submissionNotifySendsTable,
  emailSendsTable,
  subscribeAttemptsTable,
  paypalWebhookEventsTable,
  subscriptionsTable,
} from "../lib/db/schema";
import { CONFIRM_CAP_WINDOW_MS } from "../lib/email-sends";
import { DATASET_ROTATION_COOLDOWN_MS, DATASET_TERMS_VERSION, requestDatasetAccess } from "../lib/dataset-grants";
import { DATASET_PRIVACY_NOTICE } from "../lib/dataset-terms";
import type { DatasetGrantStatus } from "../lib/db/schema";
import {
  DATASET_DOWNLOAD_IP_HASH_RETENTION_DAYS,
  DATASET_DOWNLOADS_RETENTION_DAYS,
  DATASET_ENDED_RETENTION_DAYS,
  DATASET_REJECTED_RETENTION_DAYS,
  DATASET_REQUEST_IP_HASH_RETENTION_DAYS,
  DATASET_UNVERIFIED_RETENTION_DAYS,
  EMAIL_SENDS_RETENTION_DAYS,
  pruneRetentionBackups,
  RETENTION_BACKUP_RETENTION_DAYS,
  runRetentionPrune,
  PAYPAL_WEBHOOK_EVENTS_RETENTION_DAYS,
  COMMERCIAL_CHECKOUT_ABANDONED_RETENTION_DAYS,
  COMMERCIAL_CHECKOUT_PII_RETENTION_DAYS,
} from "./retention-prune";

let tdb: TestDbHandle;
let tmpBase: string;
let backupDir: string;

// Fixed clock — every window-boundary assertion below is computed relative
// to this instant, never Date.now(), so the suite can't go flaky at midnight.
const NOW = new Date("2026-09-04T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBefore = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

function readBackupLines(): { table: string; action: string; row: { id: string } }[] {
  const files = readdirSync(backupDir).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  const content = readFileSync(path.join(backupDir, files[0]), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  tmpBase = mkdtempSync(path.join(os.tmpdir(), "retention-prune-test-"));
  backupDir = path.join(tmpBase, "retention-backups");
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

afterAll(async () => {
  await tdb.client.close();
});

/** Seeds one in-window + one out-of-window (+ table-specific protected) row per table. Returns the ids expected to be mutated, per table. */
async function seedAllTables() {
  // contact_messages: retention window 180 days.
  const [contactOld] = await tdb.db
    .insert(contactMessagesTable)
    .values({
      name: "Old Sender",
      email: "old@example.com",
      topic: "other",
      message: "old message",
      createdAt: daysBefore(190),
    })
    .returning({ id: contactMessagesTable.id });
  const [contactFresh] = await tdb.db
    .insert(contactMessagesTable)
    .values({
      name: "Fresh Sender",
      email: "fresh@example.com",
      topic: "other",
      message: "fresh message",
      createdAt: daysBefore(170),
    })
    .returning({ id: contactMessagesTable.id });

  // leads: retention window 365 days, only status IN (promoted, dismissed).
  const [leadOldPromoted] = await tdb.db
    .insert(leadsTable)
    .values({ url: "https://old-promoted.example", status: "promoted", reviewedAt: daysBefore(375) })
    .returning({ id: leadsTable.id });
  const [leadFreshPromoted] = await tdb.db
    .insert(leadsTable)
    .values({ url: "https://fresh-promoted.example", status: "promoted", reviewedAt: daysBefore(355) })
    .returning({ id: leadsTable.id });
  const [leadOldNew] = await tdb.db
    .insert(leadsTable)
    .values({ url: "https://old-new.example", status: "new", reviewedAt: daysBefore(375) })
    .returning({ id: leadsTable.id });
  // COALESCE fallback: no reviewedAt at all, but createdAt is old — must still be caught.
  const [leadOldDismissedNoReview] = await tdb.db
    .insert(leadsTable)
    .values({ url: "https://old-dismissed.example", status: "dismissed", createdAt: daysBefore(375) })
    .returning({ id: leadsTable.id });

  // submissions: retention window 90 days, status != pending, strips provenance.submitterIpHash only.
  const [subOldReviewed] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: "create",
      status: "approved",
      payload: {},
      provenance: { submitterIpHash: "hash-old", sources: ["https://a.example"] },
      reviewedAt: daysBefore(100),
    })
    .returning({ id: submissionsTable.id });
  const [subFreshReviewed] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: "create",
      status: "approved",
      payload: {},
      provenance: { submitterIpHash: "hash-fresh", sources: ["https://b.example"] },
      reviewedAt: daysBefore(80),
    })
    .returning({ id: submissionsTable.id });
  // Protected: still pending, despite an old reviewedAt-shaped value — proves the
  // status!='pending' predicate itself protects it, not merely a null reviewedAt.
  const [subOldPending] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: "create",
      status: "pending",
      payload: {},
      provenance: { submitterIpHash: "hash-pending", sources: [] },
      reviewedAt: daysBefore(100),
    })
    .returning({ id: submissionsTable.id });

  // subscriptions: retention window 30 days, status == unsubscribed only.
  const [subscriptionOldUnsub] = await tdb.db
    .insert(subscriptionsTable)
    .values({
      email: "unsub-old@example.com",
      targetType: "facility",
      targetId: "facility-a",
      status: "unsubscribed",
      confirmToken: "token-unsub-old",
      unsubscribeToken: "unsub-token-old",
      unsubscribedAt: daysBefore(40),
    })
    .returning({ id: subscriptionsTable.id });
  const [subscriptionFreshUnsub] = await tdb.db
    .insert(subscriptionsTable)
    .values({
      email: "unsub-fresh@example.com",
      targetType: "facility",
      targetId: "facility-b",
      status: "unsubscribed",
      confirmToken: "token-unsub-fresh",
      unsubscribeToken: "unsub-token-fresh",
      unsubscribedAt: daysBefore(20),
    })
    .returning({ id: subscriptionsTable.id });
  const [subscriptionOldConfirmed] = await tdb.db
    .insert(subscriptionsTable)
    .values({
      email: "confirmed-old@example.com",
      targetType: "facility",
      targetId: "facility-c",
      status: "confirmed",
      confirmToken: "token-confirmed-old",
      unsubscribeToken: "unsub-token-confirmed-old",
      confirmedAt: daysBefore(400),
    })
    .returning({ id: subscriptionsTable.id });

  // subscribe_attempts: retention window 2 days, by createdAt. These are the
  // per-IP subscribe rate-limit counters; the cap window is one hour, so they
  // are the shortest-lived PII-bearing rows in the schema.
  const [attemptOld] = await tdb.db
    .insert(subscribeAttemptsTable)
    .values({ submitterIpHash: "attempt-hash-old", createdAt: daysBefore(3) })
    .returning({ id: subscribeAttemptsTable.id });
  const [attemptFresh] = await tdb.db
    .insert(subscribeAttemptsTable)
    .values({ submitterIpHash: "attempt-hash-fresh", createdAt: daysBefore(1) })
    .returning({ id: subscribeAttemptsTable.id });

  // intake_attempts: retention window 2 days, by createdAt — the exact sibling
  // of subscribe_attempts above, for the other four public write surfaces. The
  // predicate is deliberately NOT scoped by `surface` (every surface shares the
  // 1h cap window), so the old row from one surface and the old row from another
  // must BOTH be candidates while the fresh one survives.
  const [intakeOldContribute] = await tdb.db
    .insert(intakeAttemptsTable)
    .values({ surface: "contribute", submitterIpHash: "intake-hash-old-a", createdAt: daysBefore(3) })
    .returning({ id: intakeAttemptsTable.id });
  const [intakeOldContact] = await tdb.db
    .insert(intakeAttemptsTable)
    .values({ surface: "contact", submitterIpHash: "intake-hash-old-b", createdAt: daysBefore(5) })
    .returning({ id: intakeAttemptsTable.id });
  const [intakeFresh] = await tdb.db
    .insert(intakeAttemptsTable)
    .values({ surface: "leads", submitterIpHash: "intake-hash-fresh", createdAt: daysBefore(1) })
    .returning({ id: intakeAttemptsTable.id });

  // submission_notify_requests: retention window 90 days, by createdAt — a
  // surviving row this old means its submission was never reviewed (a
  // reviewed one is deleted immediately, well inside the window).
  const [notifyOld] = await tdb.db
    .insert(submissionNotifyRequestsTable)
    .values({ submissionId: randomUUID(), email: "notify-old@example.com", createdAt: daysBefore(100) })
    .returning({ id: submissionNotifyRequestsTable.id });
  const [notifyFresh] = await tdb.db
    .insert(submissionNotifyRequestsTable)
    .values({ submissionId: randomUUID(), email: "notify-fresh@example.com", createdAt: daysBefore(80) })
    .returning({ id: submissionNotifyRequestsTable.id });

  // api_access_grants: retention window 90 days, (revoked AND revokedAt old) OR (expiresAt old).
  const [grantOldRevoked] = await tdb.db
    .insert(apiAccessGrantsTable)
    .values({ email: "revoked-old@example.com", status: "revoked", confirmToken: "c1", revokedAt: daysBefore(100) })
    .returning({ id: apiAccessGrantsTable.id });
  const [grantFreshRevoked] = await tdb.db
    .insert(apiAccessGrantsTable)
    .values({ email: "revoked-fresh@example.com", status: "revoked", confirmToken: "c2", revokedAt: daysBefore(80) })
    .returning({ id: apiAccessGrantsTable.id });
  const [grantOldExpired] = await tdb.db
    .insert(apiAccessGrantsTable)
    .values({ email: "expired-old@example.com", status: "active", confirmToken: "c3", expiresAt: daysBefore(100) })
    .returning({ id: apiAccessGrantsTable.id });
  const [grantActiveFuture] = await tdb.db
    .insert(apiAccessGrantsTable)
    .values({
      email: "active-future@example.com",
      status: "active",
      confirmToken: "c4",
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    })
    .returning({ id: apiAccessGrantsTable.id });

  // api_daily_usage: retention window 35 days, `day` is a plain YYYY-MM-DD string.
  const oldDay = daysBefore(45).toISOString().slice(0, 10);
  const freshDay = daysBefore(20).toISOString().slice(0, 10);
  const [usageOld] = await tdb.db
    .insert(apiDailyUsageTable)
    .values({ ipHash: "ip-old", day: oldDay, count: 3 })
    .returning({ id: apiDailyUsageTable.id });
  const [usageFresh] = await tdb.db
    .insert(apiDailyUsageTable)
    .values({ ipHash: "ip-fresh", day: freshDay, count: 3 })
    .returning({ id: apiDailyUsageTable.id });

  return {
    contactOld: contactOld.id,
    contactFresh: contactFresh.id,
    leadOldPromoted: leadOldPromoted.id,
    leadFreshPromoted: leadFreshPromoted.id,
    leadOldNew: leadOldNew.id,
    leadOldDismissedNoReview: leadOldDismissedNoReview.id,
    subOldReviewed: subOldReviewed.id,
    subFreshReviewed: subFreshReviewed.id,
    subOldPending: subOldPending.id,
    subscriptionOldUnsub: subscriptionOldUnsub.id,
    subscriptionFreshUnsub: subscriptionFreshUnsub.id,
    subscriptionOldConfirmed: subscriptionOldConfirmed.id,
    attemptOld: attemptOld.id,
    attemptFresh: attemptFresh.id,
    intakeOldContribute: intakeOldContribute.id,
    intakeOldContact: intakeOldContact.id,
    intakeFresh: intakeFresh.id,
    notifyOld: notifyOld.id,
    notifyFresh: notifyFresh.id,
    grantOldRevoked: grantOldRevoked.id,
    grantFreshRevoked: grantFreshRevoked.id,
    grantOldExpired: grantOldExpired.id,
    grantActiveFuture: grantActiveFuture.id,
    usageOld: usageOld.id,
    usageFresh: usageFresh.id,
  };
}

describe("runRetentionPrune — dry run", () => {
  it("selects and counts candidates across every table but writes and deletes nothing", async () => {
    await seedAllTables();

    const summary = await runRetentionPrune({ apply: false, now: NOW, backupDir });

    expect(summary.dryRun).toBe(true);
    expect(summary.backupPath).toBeNull();
    expect(summary.ok).toBe(true);

    const byTable = Object.fromEntries(summary.tables.map((t) => [t.table, t]));
    expect(byTable.contact_messages.candidates).toBe(1);
    expect(byTable.leads.candidates).toBe(2); // old-promoted + old-dismissed-no-review
    expect(byTable.submissions.candidates).toBe(1);
    expect(byTable.subscriptions.candidates).toBe(1);
    expect(byTable.subscribe_attempts.candidates).toBe(1);
    expect(byTable.intake_attempts.candidates).toBe(2); // both old rows, across two surfaces
    expect(byTable.submission_notify_requests.candidates).toBe(1);
    expect(byTable.api_access_grants.candidates).toBe(2); // old-revoked + old-expired
    expect(byTable.api_daily_usage.candidates).toBe(1);
    for (const t of summary.tables) {
      expect(t.applied).toBe(0);
    }

    // Nothing written: no backup dir/files, no rows removed, no provenance stripped.
    expect(() => readdirSync(backupDir)).toThrow();
    expect(await tdb.db.select().from(subscribeAttemptsTable)).toHaveLength(2);
    expect(await tdb.db.select().from(intakeAttemptsTable)).toHaveLength(3);
    expect(await tdb.db.select().from(submissionNotifyRequestsTable)).toHaveLength(2);
    expect(await tdb.db.select().from(contactMessagesTable)).toHaveLength(2);
    expect(await tdb.db.select().from(leadsTable)).toHaveLength(4);
    const submissions = await tdb.db.select().from(submissionsTable);
    expect(submissions).toHaveLength(3);
    for (const s of submissions) {
      expect((s.provenance as Record<string, unknown>).submitterIpHash).toBeDefined();
    }
  });
});

describe("runRetentionPrune — apply", () => {
  it("mutates only rows past their retention window and leaves everything else untouched", async () => {
    const ids = await seedAllTables();

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(summary.dryRun).toBe(false);
    expect(summary.ok).toBe(true);
    expect(summary.backupPath).toBeTruthy();

    const byTable = Object.fromEntries(summary.tables.map((t) => [t.table, t]));
    expect(byTable.contact_messages).toMatchObject({ candidates: 1, applied: 1 });
    expect(byTable.leads).toMatchObject({ candidates: 2, applied: 2 });
    expect(byTable.submissions).toMatchObject({ candidates: 1, applied: 1, action: "strip-ip-hash" });
    expect(byTable.subscriptions).toMatchObject({ candidates: 1, applied: 1 });
    expect(byTable.subscribe_attempts).toMatchObject({ candidates: 1, applied: 1 });
    expect(byTable.intake_attempts).toMatchObject({ candidates: 2, applied: 2 });
    expect(byTable.submission_notify_requests).toMatchObject({ candidates: 1, applied: 1 });
    expect(byTable.api_access_grants).toMatchObject({ candidates: 2, applied: 2 });
    expect(byTable.api_daily_usage).toMatchObject({ candidates: 1, applied: 1 });

    // contact_messages: only the old row is gone.
    const remainingContacts = await tdb.db.select().from(contactMessagesTable);
    expect(remainingContacts.map((r) => r.id)).toEqual([ids.contactFresh]);

    // leads: old-promoted and old-dismissed-no-review are gone; fresh-promoted and
    // the status='new' row (however old) survive.
    const remainingLeads = await tdb.db.select().from(leadsTable);
    expect(new Set(remainingLeads.map((r) => r.id))).toEqual(
      new Set([ids.leadFreshPromoted, ids.leadOldNew])
    );

    // submissions: no row is ever deleted; only the reviewed+old row loses its hash.
    const remainingSubs = await tdb.db.select().from(submissionsTable);
    expect(remainingSubs).toHaveLength(3);
    const subOld = remainingSubs.find((r) => r.id === ids.subOldReviewed)!;
    expect((subOld.provenance as Record<string, unknown>).submitterIpHash).toBeUndefined();
    expect((subOld.provenance as { sources: string[] }).sources).toEqual(["https://a.example"]); // other keys survive
    const subFresh = remainingSubs.find((r) => r.id === ids.subFreshReviewed)!;
    expect((subFresh.provenance as Record<string, unknown>).submitterIpHash).toBe("hash-fresh");
    const subPending = remainingSubs.find((r) => r.id === ids.subOldPending)!;
    expect((subPending.provenance as Record<string, unknown>).submitterIpHash).toBe("hash-pending");

    // subscriptions: only the old unsubscribed row is gone.
    const remainingSubscriptions = await tdb.db.select().from(subscriptionsTable);
    expect(new Set(remainingSubscriptions.map((r) => r.id))).toEqual(
      new Set([ids.subscriptionFreshUnsub, ids.subscriptionOldConfirmed])
    );

    // subscribe_attempts: only the 3-day-old counter row is gone.
    const remainingAttempts = await tdb.db.select().from(subscribeAttemptsTable);
    expect(remainingAttempts.map((r) => r.id)).toEqual([ids.attemptFresh]);

    // intake_attempts: both aged rows are gone regardless of surface, the fresh
    // one survives — the prune is by age only, never per-surface.
    const remainingIntake = await tdb.db.select().from(intakeAttemptsTable);
    expect(remainingIntake.map((r) => r.id)).toEqual([ids.intakeFresh]);

    // submission_notify_requests: only the never-reviewed (100-day-old) row is gone.
    const remainingNotify = await tdb.db.select().from(submissionNotifyRequestsTable);
    expect(remainingNotify.map((r) => r.id)).toEqual([ids.notifyFresh]);

    // api_access_grants: both the old-revoked and old-expired rows are gone.
    const remainingGrants = await tdb.db.select().from(apiAccessGrantsTable);
    expect(new Set(remainingGrants.map((r) => r.id))).toEqual(
      new Set([ids.grantFreshRevoked, ids.grantActiveFuture])
    );

    // api_daily_usage: only the old day-bucket is gone.
    const remainingUsage = await tdb.db.select().from(apiDailyUsageTable);
    expect(remainingUsage.map((r) => r.id)).toEqual([ids.usageFresh]);

    // Backup file: exactly one JSONL line per applied mutation, correctly tagged.
    const lines = readBackupLines();
    expect(lines).toHaveLength(12); // 1+2+1+1+1+2+1+2+1 == sum of `applied` above
    const byId = Object.fromEntries(lines.map((l) => [l.row.id, l]));
    expect(byId[ids.contactOld]).toMatchObject({ table: "contact_messages", action: "delete" });
    expect(byId[ids.leadOldPromoted]).toMatchObject({ table: "leads", action: "delete" });
    expect(byId[ids.leadOldDismissedNoReview]).toMatchObject({ table: "leads", action: "delete" });
    expect(byId[ids.subOldReviewed]).toMatchObject({ table: "submissions", action: "strip-ip-hash" });
    expect(byId[ids.subscriptionOldUnsub]).toMatchObject({ table: "subscriptions", action: "delete" });
    expect(byId[ids.attemptOld]).toMatchObject({ table: "subscribe_attempts", action: "delete" });
    expect(byId[ids.intakeOldContribute]).toMatchObject({ table: "intake_attempts", action: "delete" });
    expect(byId[ids.intakeOldContact]).toMatchObject({ table: "intake_attempts", action: "delete" });
    expect(byId[ids.notifyOld]).toMatchObject({ table: "submission_notify_requests", action: "delete" });
    expect(byId[ids.grantOldRevoked]).toMatchObject({ table: "api_access_grants", action: "delete" });
    expect(byId[ids.grantOldExpired]).toMatchObject({ table: "api_access_grants", action: "delete" });
    expect(byId[ids.usageOld]).toMatchObject({ table: "api_daily_usage", action: "delete" });
    // Rows that must NOT appear in the backup at all (never touched).
    for (const untouchedId of [ids.contactFresh, ids.leadFreshPromoted, ids.leadOldNew, ids.subFreshReviewed, ids.subOldPending, ids.attemptFresh, ids.intakeFresh, ids.notifyFresh]) {
      expect(byId[untouchedId]).toBeUndefined();
    }
  });
});

describe("runRetentionPrune — window boundary", () => {
  it("a row exactly one day inside the contact_messages window survives; one day outside is deleted", async () => {
    const [insideId] = (
      await tdb.db
        .insert(contactMessagesTable)
        .values({
          name: "Inside",
          email: "inside@example.com",
          topic: "other",
          message: "inside window",
          createdAt: daysBefore(179), // 180-day window minus 1 day => still inside
        })
        .returning({ id: contactMessagesTable.id })
    );
    const [outsideId] = (
      await tdb.db
        .insert(contactMessagesTable)
        .values({
          name: "Outside",
          email: "outside@example.com",
          topic: "other",
          message: "outside window",
          createdAt: daysBefore(181), // 180-day window plus 1 day => outside
        })
        .returning({ id: contactMessagesTable.id })
    );

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const remaining = await tdb.db.select().from(contactMessagesTable);
    expect(remaining.map((r) => r.id)).toEqual([insideId.id]);
    const lines = readBackupLines();
    expect(lines.map((l) => l.row.id)).toEqual([outsideId.id]);
  });
});

// Isolated (not folded into seedAllTables/the dry-run/apply tests above) so a
// new table here never has to touch that fixture's many hardcoded per-table
// candidate/applied counts and the aggregate backup-line count — same
// self-contained shape as "window boundary" above.
describe("runRetentionPrune — submission_notify_sends (persistent send-attempt counter)", () => {
  it("a 70-day-old row is a candidate; a 50-day-old row is not", async () => {
    const [oldId] = await tdb.db
      .insert(submissionNotifySendsTable)
      .values({ emailHash: "hash-old", createdAt: daysBefore(70) })
      .returning({ id: submissionNotifySendsTable.id });
    const [freshId] = await tdb.db
      .insert(submissionNotifySendsTable)
      .values({ emailHash: "hash-fresh", createdAt: daysBefore(50) })
      .returning({ id: submissionNotifySendsTable.id });

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const outcome = summary.tables.find((t) => t.table === "submission_notify_sends")!;
    expect(outcome).toMatchObject({ candidates: 1, applied: 1, action: "delete" });

    const remaining = await tdb.db.select().from(submissionNotifySendsTable);
    expect(remaining.map((r) => r.id)).toEqual([freshId.id]);

    const lines = readBackupLines();
    expect(lines.map((l) => l.row.id)).toEqual([oldId.id]);
    expect(lines[0]).toMatchObject({ table: "submission_notify_sends", action: "delete" });
  });
});

describe("runRetentionPrune — backup failure is back-up-or-abort", () => {
  it("skips the mutation, leaves the row in place, and reports failure when the backup path can't be written", async () => {
    // Occupy the backup directory's path with a plain FILE, so mkdirSync(...,
    // {recursive:true}) inside appendBackup throws instead of creating a dir.
    writeFileSync(backupDir, "not a directory");

    const [contactOld] = await tdb.db
      .insert(contactMessagesTable)
      .values({
        name: "Old Sender",
        email: "old@example.com",
        topic: "other",
        message: "old message",
        createdAt: daysBefore(190),
      })
      .returning({ id: contactMessagesTable.id });

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(summary.ok).toBe(false);
    expect(summary.backups.error).toBeDefined();
    const contactOutcome = summary.tables.find((t) => t.table === "contact_messages")!;
    expect(contactOutcome.candidates).toBe(1);
    expect(contactOutcome.applied).toBe(0);
    expect(contactOutcome.error).toMatch(/backup failed, mutation skipped/);

    // The row survives — the mutation was never attempted.
    const remaining = await tdb.db.select().from(contactMessagesTable);
    expect(remaining.map((r) => r.id)).toEqual([contactOld.id]);
  });
});

describe("runRetentionPrune — email_sends (outbound send log)", () => {
  it("a 200-day-old row is a candidate; a 170-day-old row is not", async () => {
    const [oldId] = await tdb.db
      .insert(emailSendsTable)
      .values({ kind: "confirm", emailHash: "hash-old", createdAt: daysBefore(200) })
      .returning({ id: emailSendsTable.id });
    const [freshId] = await tdb.db
      .insert(emailSendsTable)
      .values({ kind: "confirm", emailHash: "hash-fresh", createdAt: daysBefore(170) })
      .returning({ id: emailSendsTable.id });

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const outcome = summary.tables.find((t) => t.table === "email_sends")!;
    expect(outcome).toMatchObject({ candidates: 1, applied: 1, action: "delete" });

    const remaining = await tdb.db.select().from(emailSendsTable);
    expect(remaining.map((r) => r.id)).toEqual([freshId.id]);
    expect(readBackupLines().map((l) => l.row.id)).toEqual([oldId.id]);
  });

  it("retention is at least 3x the confirm-cap window, so pruning can never shorten the cap", () => {
    expect(EMAIL_SENDS_RETENTION_DAYS * 86_400_000).toBeGreaterThanOrEqual(3 * CONFIRM_CAP_WINDOW_MS);
  });
});

describe("runRetentionPrune — paypal_webhook_events (webhook idempotency log)", () => {
  it("deletes processed rows past the window; keeps recent and unprocessed rows; dry run changes nothing", async () => {
    const cutoff = daysBefore(PAYPAL_WEBHOOK_EVENTS_RETENTION_DAYS);
    await tdb.db.insert(paypalWebhookEventsTable).values([
      { id: "WH-old", eventType: "BILLING.SUBSCRIPTION.ACTIVATED", receivedAt: daysBefore(200), processedAt: new Date(cutoff.getTime() - 1) },
      { id: "WH-recent", eventType: "BILLING.SUBSCRIPTION.ACTIVATED", receivedAt: daysBefore(10), processedAt: daysBefore(10) },
      { id: "WH-unprocessed", eventType: "BILLING.SUBSCRIPTION.ACTIVATED", receivedAt: daysBefore(200), processedAt: null },
    ]);

    const dry = await runRetentionPrune({ apply: false, now: NOW, backupDir });
    expect(dry.tables.find((t) => t.table === "paypal_webhook_events")).toMatchObject({ candidates: 1, applied: 0 });
    expect(await tdb.db.select().from(paypalWebhookEventsTable)).toHaveLength(3);

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.tables.find((t) => t.table === "paypal_webhook_events")).toMatchObject({
      candidates: 1,
      applied: 1,
      action: "delete",
    });
    const remaining = (await tdb.db.select().from(paypalWebhookEventsTable)).map((r) => r.id).sort();
    expect(remaining).toEqual(["WH-recent", "WH-unprocessed"]);
    expect(readBackupLines().map((l) => l.table)).toEqual(["paypal_webhook_events"]);
  });
});

describe("runRetentionPrune — commercial_checkouts", () => {
  const base = { plan: "monthly" as const, termsVersion: "test" };
  const rowsById = async () =>
    new Map((await tdb.db.select().from(commercialCheckoutsTable)).map((r) => [r.paypalSubscriptionId, r]));

  it("deletes abandoned attempts past the window, keeps recent and decided ones; dry run changes nothing", async () => {
    const past = (days: number) => new Date(daysBefore(days).getTime() - 1);
    await tdb.db.insert(commercialCheckoutsTable).values([
      { ...base, email: "a@example.com", paypalSubscriptionId: "abandoned-old", createdAt: past(COMMERCIAL_CHECKOUT_ABANDONED_RETENTION_DAYS) },
      { ...base, email: "b@example.com", paypalSubscriptionId: "abandoned-recent", createdAt: daysBefore(5) },
      { ...base, email: "c@example.com", paypalSubscriptionId: "decided-old", decision: "activate", createdAt: past(100) },
    ]);

    const dry = await runRetentionPrune({ apply: false, now: NOW, backupDir });
    const dryDelete = dry.tables.find((t) => t.table === "commercial_checkouts" && t.action === "delete");
    expect(dryDelete).toMatchObject({ candidates: 1, applied: 0 });
    expect(await tdb.db.select().from(commercialCheckoutsTable)).toHaveLength(3);

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.tables.find((t) => t.table === "commercial_checkouts" && t.action === "delete")).toMatchObject({
      candidates: 1,
      applied: 1,
    });
    expect([...(await rowsById()).keys()].sort()).toEqual(["abandoned-recent", "decided-old"]);
  });

  it("scrubs email, name and organization on decided rows past the window; keeps the decision record", async () => {
    const old = new Date(daysBefore(COMMERCIAL_CHECKOUT_PII_RETENTION_DAYS).getTime() - 1);
    await tdb.db.insert(commercialCheckoutsTable).values([
      { ...base, email: "d@example.com", name: "D", organization: "Org", paypalSubscriptionId: "scrub-me", decision: "refuse", reason: "duplicate_subscription", createdAt: old },
      { ...base, email: "e@example.com", name: "E", paypalSubscriptionId: "too-recent", decision: "activate", createdAt: daysBefore(100) },
      { ...base, paypalSubscriptionId: "already-clean", decision: "activate", createdAt: old },
      { ...base, email: "f@example.com", paypalSubscriptionId: "email-only", decision: "activate", createdAt: old },
      // Undecided: only the abandoned-delete step may take it; the scrub step must not count it.
      { ...base, email: "g@example.com", paypalSubscriptionId: "undecided-old", createdAt: old },
    ]);

    const dry = await runRetentionPrune({ apply: false, now: NOW, backupDir });
    // scrub-me + email-only; not already-clean, too-recent or the undecided row.
    expect(dry.tables.find((t) => t.action === "scrub-pii")).toMatchObject({ candidates: 2, applied: 0 });
    expect((await rowsById()).get("scrub-me")?.email).toBe("d@example.com");

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.tables.find((t) => t.action === "scrub-pii")).toMatchObject({ candidates: 2, applied: 2 });
    const rows = await rowsById();
    expect(rows.get("scrub-me")).toMatchObject({ email: null, name: null, organization: null, decision: "refuse", reason: "duplicate_subscription" });
    expect(rows.get("email-only")).toMatchObject({ email: null, decision: "activate" });
    expect(rows.get("too-recent")?.email).toBe("e@example.com");
    // The undecided row is gone via the abandoned-delete step, never scrubbed.
    expect([...rows.keys()].sort()).toEqual(["already-clean", "email-only", "scrub-me", "too-recent"]);
  });
});

// --- dataset sharing (dataset_access_grants / dataset_downloads) --------------
// Every window below is pinned to the public privacy notice (DATASET_PRIVACY_NOTICE
// in lib/dataset-terms.ts): the notice is binding, so a constant that drifts from
// it fails here rather than silently over- or under-retaining personal data.
const MS = 1;

let grantSeq = 0;
async function insertGrant(
  status: DatasetGrantStatus,
  dates: Partial<{
    createdAt: Date;
    reviewedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date | null;
    submitterIpHash: string | null;
  }> = {}
): Promise<string> {
  grantSeq += 1;
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: `grant-${grantSeq}@example.com`,
      name: "Grant Person",
      category: "journalist",
      intendedUse: "reporting",
      attributionAckAt: daysBefore(1000),
      termsVersion: "test",
      verifyTokenHash: randomUUID(),
      status,
      ...dates,
    })
    .returning({ id: datasetAccessGrantsTable.id });
  return row.id;
}

async function insertDownload(grantId: string, createdAt: Date, ipHash: string | null = null): Promise<string> {
  const [row] = await tdb.db
    .insert(datasetDownloadsTable)
    .values({ grantId, file: "facilities.csv", outcome: "served", createdAt, ipHash })
    .returning({ id: datasetDownloadsTable.id });
  return row.id;
}

const grantIds = async () => (await tdb.db.select().from(datasetAccessGrantsTable)).map((r) => r.id);
const downloadIds = async () => (await tdb.db.select().from(datasetDownloadsTable)).map((r) => r.id);

describe("dataset retention — windows match the public privacy notice", () => {
  const notice = DATASET_PRIVACY_NOTICE.join(" ");

  it("pins each constant to the figure the notice states", () => {
    expect(notice).toContain(`Unverified requests are deleted after ${DATASET_UNVERIFIED_RETENTION_DAYS} days`);
    expect(notice).toContain(`Rejected requests are deleted ${DATASET_REJECTED_RETENTION_DAYS} days after review`);
    expect(notice).toContain(
      `Revoked or expired grants are deleted ${DATASET_ENDED_RETENTION_DAYS} days after revocation or expiry`
    );
    expect(notice).toContain(
      `hashed IP on a request is cleared ${DATASET_REQUEST_IP_HASH_RETENTION_DAYS} days after review`
    );
    expect(notice).toContain(`Download records are deleted after ${DATASET_DOWNLOADS_RETENTION_DAYS} days`);
    expect(notice).toContain(`their hashed IPs are cleared after ${DATASET_DOWNLOAD_IP_HASH_RETENTION_DAYS} days`);
    expect(notice).toContain(`Email logs are deleted after ${EMAIL_SENDS_RETENTION_DAYS} days`);
    expect(notice).toContain(`that backup is deleted after ${RETENTION_BACKUP_RETENTION_DAYS} days`);
    expect(notice).toContain("including cleared hashed IPs");
  });
});

describe("dataset retention — dataset_access_grants deletes", () => {
  it("unverified: deleted strictly after 7 days (by createdAt); exactly at the cutoff survives", async () => {
    const cutoff = daysBefore(DATASET_UNVERIFIED_RETENTION_DAYS);
    const atCutoff = await insertGrant("unverified", { createdAt: cutoff });
    const pastCutoff = await insertGrant("unverified", { createdAt: new Date(cutoff.getTime() - MS) });
    const fresh = await insertGrant("unverified", { createdAt: daysBefore(1) });

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    expect(new Set(await grantIds())).toEqual(new Set([atCutoff, fresh]));
    expect(readBackupLines().map((l) => l.row.id)).toEqual([pastCutoff]);
  });

  it("rejected: deleted strictly after 180 days from reviewedAt, not createdAt", async () => {
    const cutoff = daysBefore(DATASET_REJECTED_RETENTION_DAYS);
    const atCutoff = await insertGrant("rejected", { createdAt: daysBefore(400), reviewedAt: cutoff });
    const pastCutoff = await insertGrant("rejected", {
      createdAt: daysBefore(400),
      reviewedAt: new Date(cutoff.getTime() - MS),
    });
    // Old createdAt but recently reviewed: the clock runs from review.
    const recentlyReviewed = await insertGrant("rejected", { createdAt: daysBefore(400), reviewedAt: daysBefore(10) });

    await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(new Set(await grantIds())).toEqual(new Set([atCutoff, recentlyReviewed]));
    expect(readBackupLines().map((l) => l.row.id)).toEqual([pastCutoff]);
  });

  it("revoked: deleted strictly after 365 days from revokedAt", async () => {
    const cutoff = daysBefore(DATASET_ENDED_RETENTION_DAYS);
    const atCutoff = await insertGrant("revoked", { revokedAt: cutoff });
    const pastCutoff = await insertGrant("revoked", { revokedAt: new Date(cutoff.getTime() - MS) });

    await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(await grantIds()).toEqual([atCutoff]);
    expect(readBackupLines().map((l) => l.row.id)).toEqual([pastCutoff]);
  });

  it("expired: deleted strictly after 365 days from expiresAt; a NULL expiresAt is never selected", async () => {
    const cutoff = daysBefore(DATASET_ENDED_RETENTION_DAYS);
    const atCutoff = await insertGrant("expired", { expiresAt: cutoff });
    const pastCutoff = await insertGrant("expired", { expiresAt: new Date(cutoff.getTime() - MS) });
    const nullExpiry = await insertGrant("expired", { expiresAt: null, createdAt: daysBefore(2000) });

    await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(new Set(await grantIds())).toEqual(new Set([atCutoff, nullExpiry]));
    expect(readBackupLines().map((l) => l.row.id)).toEqual([pastCutoff]);
  });

  it("each rule keys on its own status: a revoked row is not caught by the expired clock and vice versa", async () => {
    // revoked with an ancient expiresAt but a recent revokedAt; expired with an ancient revokedAt but a recent expiresAt.
    const revoked = await insertGrant("revoked", { revokedAt: daysBefore(5), expiresAt: daysBefore(900) });
    const expired = await insertGrant("expired", { expiresAt: daysBefore(5), revokedAt: daysBefore(900) });
    // rejected / unverified rows with an ancient revokedAt/expiresAt are not caught by the ended rule.
    const rejected = await insertGrant("rejected", { reviewedAt: daysBefore(5), expiresAt: daysBefore(900) });
    const unverified = await insertGrant("unverified", { createdAt: daysBefore(1), revokedAt: daysBefore(900) });

    await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(new Set(await grantIds())).toEqual(new Set([revoked, expired, rejected, unverified]));
  });

  it("never selects active or pending_review rows, however old, including an active row past its expiry", async () => {
    const ancient = daysBefore(2000);
    const active = await insertGrant("active", {
      createdAt: ancient,
      reviewedAt: ancient,
      revokedAt: ancient,
      expiresAt: ancient,
    });
    // A renewal-pending grant: active, past expiresAt, renewal requested. Must survive.
    const renewalPending = await insertGrant("active", { createdAt: ancient, reviewedAt: ancient, expiresAt: daysBefore(400) });
    const pending = await insertGrant("pending_review", {
      createdAt: ancient,
      reviewedAt: ancient,
      revokedAt: ancient,
      expiresAt: ancient,
    });

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const grants = summary.tables.filter((t) => t.table === "dataset_access_grants" && t.action === "delete");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ candidates: 0, applied: 0 });
    expect(new Set(await grantIds())).toEqual(new Set([active, renewalPending, pending]));
  });

  it("deleting an ended grant cascades its downloads", async () => {
    const ended = await insertGrant("revoked", { revokedAt: daysBefore(400) });
    await insertDownload(ended, daysBefore(500));
    const kept = await insertGrant("active", { reviewedAt: daysBefore(10) });
    const keptDownload = await insertDownload(kept, daysBefore(1));

    await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(await grantIds()).toEqual([kept]);
    expect(await downloadIds()).toEqual([keptDownload]);
  });
});

describe("dataset retention — unverified clock vs. verification-link rotation", () => {
  const MINUTE_MS = 60 * 1000;
  const requestA = {
    email: "rotator@example.com",
    name: "Alice Anderson",
    organization: "Alpha Organization",
    role: "Alpha Role",
    category: "academic",
    intendedUse: "Alpha intended use: a thesis on cooling water.",
    links: ["https://alpha.example/one", "https://alpha.example/two"],
    attributionAck: true,
    termsAccepted: true,
  };
  const requestB = {
    email: "ROTATOR@example.com", // same address, different case: normalized to the same row
    name: "Bruno Baker",
    category: "journalist",
    intendedUse: "Beta intended use: a story on siting.",
    links: ["https://beta.example/story"],
    attributionAck: true,
    termsAccepted: true,
    // no organization or role: B must NULL out A's, not leave them behind
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a rotation replaces every request field, so no earlier request's data outlives its 7 days: the unverified clock restarts with the new request, not with the row", async () => {
    const first = await requestDatasetAccess(requestA, "iphash-A");
    if (!first.ok || first.mail?.kind !== "dataset_verify") throw new Error("expected a verify intent");
    const [rowA] = await tdb.db.select().from(datasetAccessGrantsTable);
    expect(rowA).toMatchObject({
      name: "Alice Anderson",
      organization: "Alpha Organization",
      role: "Alpha Role",
      category: "academic",
      submitterIpHash: "iphash-A",
    });

    // Re-request after the rotation cooldown. Age the row (createdAt and the acknowledgement stamp)
    // so the rotation is visibly what moves them.
    const aged = new Date(Date.now() - 2 * DATASET_ROTATION_COOLDOWN_MS);
    await tdb.db
      .update(datasetAccessGrantsTable)
      .set({ createdAt: aged, attributionAckAt: aged, termsVersion: "terms-acknowledged-with-A" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 21 * MINUTE_MS);
    const second = await requestDatasetAccess(requestB, "iphash-B");
    vi.useRealTimers();
    if (!second.ok || second.mail?.kind !== "dataset_verify") throw new Error("expected a rotation verify intent");
    expect(second.mail.grantId).toBe(first.mail.grantId); // the SAME row

    const rows = await tdb.db.select().from(datasetAccessGrantsTable);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Every request field now holds B's value (the ones B left empty are NULL, not A's)...
    // (`requestFields` in lib/dataset-grants.ts: name, organization, role, category, intendedUse, links,
    // attributionAckAt, termsVersion, submitterIpHash.)
    expect(row).toMatchObject({
      id: first.mail.grantId,
      status: "unverified",
      name: "Bruno Baker",
      organization: null,
      role: null,
      category: "journalist",
      intendedUse: "Beta intended use: a story on siting.",
      links: ["https://beta.example/story"],
      submitterIpHash: "iphash-B",
    });
    expect(row.attributionAckAt.getTime()).toBeGreaterThan(aged.getTime());
    expect(row.termsVersion).toBe(DATASET_TERMS_VERSION);
    expect(row.createdAt.getTime()).toBeGreaterThan(aged.getTime());
    expect(row.verifyTokenHash).not.toBe(rowA.verifyTokenHash);

    // ...and nothing of A survives anywhere in the stored row.
    const stored = JSON.stringify(row);
    for (const fromA of ["Alice", "Anderson", "Alpha", "alpha.example", "iphash-A", "thesis", "academic"]) {
      expect(stored).not.toContain(fromA);
    }

    // Retention: the 7 days run from B (the rotated createdAt), strictly.
    const cutoffAtB = new Date(row.createdAt.getTime() + DATASET_UNVERIFIED_RETENTION_DAYS * DAY_MS);
    const dry = await runRetentionPrune({ apply: false, now: cutoffAtB, backupDir });
    expect(dry.tables.find((t) => t.table === "dataset_access_grants" && t.action === "delete")).toMatchObject({
      candidates: 0, // exactly 7 d after B: survives
    });
    const dryLater = await runRetentionPrune({
      apply: false,
      now: new Date(cutoffAtB.getTime() + 1),
      backupDir,
    });
    expect(dryLater.tables.find((t) => t.table === "dataset_access_grants" && t.action === "delete")).toMatchObject({
      candidates: 1, // a millisecond past 7 d after B: deleted
    });
    // (Measured from A's request the row would already be 7 d past; A's data is gone either way.)
    const applied = await runRetentionPrune({ apply: true, now: new Date(cutoffAtB.getTime() + 1), backupDir });
    expect(applied.ok).toBe(true);
    expect(await grantIds()).toEqual([]);
  });
});

describe("dataset retention — dataset_downloads", () => {
  it("deletes strictly after 365 days; exactly at the cutoff survives", async () => {
    const grant = await insertGrant("active", { reviewedAt: daysBefore(10) });
    const cutoff = daysBefore(DATASET_DOWNLOADS_RETENTION_DAYS);
    const atCutoff = await insertDownload(grant, cutoff);
    const pastCutoff = await insertDownload(grant, new Date(cutoff.getTime() - MS));
    const fresh = await insertDownload(grant, daysBefore(30));

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    expect(new Set(await downloadIds())).toEqual(new Set([atCutoff, fresh]));
    expect(readBackupLines().filter((l) => l.table === "dataset_downloads").map((l) => l.row.id)).toEqual([pastCutoff]);
  });

  it("strips the IP hash strictly after 90 days, leaving the row and its other columns", async () => {
    const grant = await insertGrant("active", { reviewedAt: daysBefore(10) });
    const cutoff = daysBefore(DATASET_DOWNLOAD_IP_HASH_RETENTION_DAYS);
    const atCutoff = await insertDownload(grant, cutoff, "hash-at");
    const pastCutoff = await insertDownload(grant, new Date(cutoff.getTime() - MS), "hash-past");
    const noHash = await insertDownload(grant, daysBefore(200), null);

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    // Only the row that is past the cutoff AND still carries a hash is a candidate.
    const outcome = summary.tables.find((t) => t.table === "dataset_downloads" && t.action === "strip-ip-hash")!;
    expect(outcome).toMatchObject({ candidates: 1, applied: 1 });

    const rows = await tdb.db.select().from(datasetDownloadsTable);
    expect(rows).toHaveLength(3);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[atCutoff].ipHash).toBe("hash-at");
    expect(byId[pastCutoff].ipHash).toBeNull();
    expect(byId[pastCutoff]).toMatchObject({ file: "facilities.csv", outcome: "served", grantId: grant });
    expect(byId[noHash].ipHash).toBeNull();
    expect(readBackupLines().filter((l) => l.action === "strip-ip-hash").map((l) => l.row.id)).toEqual([pastCutoff]);
  });
});

describe("dataset retention — dataset_access_grants IP-hash strip", () => {
  it("clears submitterIpHash strictly after 90 days from reviewedAt, for any reviewed status, and keeps the row", async () => {
    const cutoff = daysBefore(DATASET_REQUEST_IP_HASH_RETENTION_DAYS);
    const atCutoff = await insertGrant("active", { reviewedAt: cutoff, submitterIpHash: "h-at" });
    const pastActive = await insertGrant("active", { reviewedAt: new Date(cutoff.getTime() - MS), submitterIpHash: "h-active" });
    const pastRevoked = await insertGrant("revoked", {
      reviewedAt: daysBefore(100),
      revokedAt: daysBefore(50),
      submitterIpHash: "h-revoked",
    });
    // Never reviewed: the clock has not started, so the hash stays however old the request is.
    const unreviewed = await insertGrant("pending_review", { createdAt: daysBefore(500), reviewedAt: null, submitterIpHash: "h-unrev" });
    const alreadyNull = await insertGrant("active", { reviewedAt: daysBefore(200), submitterIpHash: null });

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const outcome = summary.tables.find((t) => t.table === "dataset_access_grants" && t.action === "strip-ip-hash")!;
    expect(outcome).toMatchObject({ candidates: 2, applied: 2 });

    const rows = await tdb.db.select().from(datasetAccessGrantsTable);
    expect(rows).toHaveLength(5); // strip never deletes
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[atCutoff].submitterIpHash).toBe("h-at");
    expect(byId[pastActive].submitterIpHash).toBeNull();
    expect(byId[pastActive]).toMatchObject({ status: "active", email: expect.stringContaining("@example.com") });
    expect(byId[pastRevoked].submitterIpHash).toBeNull();
    expect(byId[unreviewed].submitterIpHash).toBe("h-unrev");
    expect(byId[alreadyNull].submitterIpHash).toBeNull();
  });
});

describe("dataset retention — run-level behaviour", () => {
  async function seedDatasetRows() {
    const unverified = await insertGrant("unverified", { createdAt: daysBefore(8) });
    const ended = await insertGrant("revoked", { revokedAt: daysBefore(400), reviewedAt: daysBefore(500) });
    const endedDownload = await insertDownload(ended, daysBefore(450), "h-ended");
    const live = await insertGrant("active", { reviewedAt: daysBefore(120), submitterIpHash: "h-live" });
    const oldDownload = await insertDownload(live, daysBefore(400), "h-old");
    const midDownload = await insertDownload(live, daysBefore(100), "h-mid");
    return { unverified, ended, endedDownload, live, oldDownload, midDownload };
  }

  it("dry run reports candidates for all four dataset steps and changes nothing", async () => {
    await seedDatasetRows();

    const summary = await runRetentionPrune({ apply: false, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const find = (table: string, action: string) => summary.tables.find((t) => t.table === table && t.action === action)!;
    expect(find("dataset_downloads", "delete")).toMatchObject({ candidates: 2, applied: 0 }); // endedDownload + oldDownload
    expect(find("dataset_access_grants", "delete")).toMatchObject({ candidates: 2, applied: 0 }); // unverified + ended
    expect(find("dataset_downloads", "strip-ip-hash")).toMatchObject({ candidates: 3, applied: 0 }); // every seeded download is >90 d old and carries a hash
    expect(find("dataset_access_grants", "strip-ip-hash")).toMatchObject({ candidates: 1, applied: 0 }); // only `live` still holds a hash

    expect(() => readdirSync(backupDir)).toThrow(); // no backup dir in a dry run
    expect(await grantIds()).toHaveLength(3);
    expect(await downloadIds()).toHaveLength(3);
    const live = (await tdb.db.select().from(datasetAccessGrantsTable)).filter((g) => g.status === "active");
    expect(live[0].submitterIpHash).toBe("h-live");
  });

  it("backs up every dataset row before mutating, including rows a cascade removes", async () => {
    const ids = await seedDatasetRows();

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const lines = readBackupLines();
    const has = (table: string, action: string, id: string) =>
      lines.some((l) => l.table === table && l.action === action && l.row.id === id);
    expect(has("dataset_access_grants", "delete", ids.unverified)).toBe(true);
    expect(has("dataset_access_grants", "delete", ids.ended)).toBe(true);
    // The cascaded download is in the backup because the downloads step runs before the grants delete.
    expect(has("dataset_downloads", "delete", ids.endedDownload)).toBe(true);
    expect(has("dataset_downloads", "delete", ids.oldDownload)).toBe(true);
    expect(has("dataset_access_grants", "strip-ip-hash", ids.live)).toBe(true);
    expect(has("dataset_downloads", "strip-ip-hash", ids.midDownload)).toBe(true);

    expect(await grantIds()).toEqual([ids.live]);
    expect(await downloadIds()).toEqual([ids.midDownload]);
    const [midRow] = await tdb.db.select().from(datasetDownloadsTable);
    expect(midRow.ipHash).toBeNull();
  });

  it("skips every dataset mutation when the backup cannot be written", async () => {
    writeFileSync(backupDir, "not a directory");
    const ids = await seedDatasetRows();

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });

    expect(summary.ok).toBe(false);
    for (const t of summary.tables.filter((x) => x.table.startsWith("dataset_"))) {
      expect(t.applied).toBe(0);
    }
    expect(new Set(await grantIds())).toEqual(new Set([ids.unverified, ids.ended, ids.live]));
    expect(await downloadIds()).toHaveLength(3);
  });

  it("invariant: no download younger than 365 days is ever cascade-deleted by a grant delete", async () => {
    // A grant only ends (revoked/expired) after its last logged download, because downloads are logged
    // for active, unexpired grants only. So a grant ≥365 d past its end has only downloads ≥365 d old.
    const endedRevoked = await insertGrant("revoked", { reviewedAt: daysBefore(800), revokedAt: daysBefore(400) });
    const endedExpired = await insertGrant("expired", { reviewedAt: daysBefore(800), expiresAt: daysBefore(400) });
    // Boundary: ended exactly one ms past the cutoff, last download a moment before it ended.
    const justEnded = await insertGrant("revoked", {
      reviewedAt: daysBefore(800),
      revokedAt: new Date(daysBefore(DATASET_ENDED_RETENTION_DAYS).getTime() - MS),
    });
    await insertDownload(endedRevoked, daysBefore(401));
    await insertDownload(endedExpired, daysBefore(401));
    await insertDownload(justEnded, new Date(daysBefore(DATASET_ENDED_RETENTION_DAYS).getTime() - 2 * MS));
    // Downloads of a live grant, including one exactly at the 365-day boundary, are untouched.
    const live = await insertGrant("active", { reviewedAt: daysBefore(800) });
    const young = await insertDownload(live, daysBefore(DATASET_DOWNLOADS_RETENTION_DAYS));

    const before = (await tdb.db.select().from(datasetDownloadsTable)).filter(
      (d) => d.createdAt.getTime() >= daysBefore(DATASET_DOWNLOADS_RETENTION_DAYS).getTime()
    );
    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(true);

    const after = new Set(await downloadIds());
    for (const d of before) expect(after.has(d.id)).toBe(true); // nothing younger than the window was lost
    expect(after).toEqual(new Set([young]));
    expect(await grantIds()).toEqual([live]);
  });
});

describe("retention backups — 30-day file TTL", () => {
  const nameAt = (d: Date): string => `retention-${d.toISOString().replace(/[:.]/g, "-")}.jsonl`;

  function seedDir(): { oldFile: string; survivors: string[]; outside: string } {
    mkdirSync(backupDir, { recursive: true });
    const oldFile = nameAt(daysBefore(31));
    writeFileSync(path.join(backupDir, oldFile), "{}\n");
    const survivors = [
      nameAt(daysBefore(10)),
      nameAt(daysBefore(RETENTION_BACKUP_RETENTION_DAYS)), // exactly at the cutoff
      "notes.txt",
      "retention-foo.jsonl",
      "retention-2020-01-01T00-00-00-000Z.jsonl.bak",
    ];
    for (const f of survivors) writeFileSync(path.join(backupDir, f), "keep\n");
    const outside = path.join(tmpBase, "outside-target.txt");
    writeFileSync(outside, "keep\n");
    const link = `retention-2020-01-01T00-00-00-001Z.jsonl`;
    symlinkSync(outside, path.join(backupDir, link));
    const dir = `retention-2020-01-01T00-00-00-002Z.jsonl`;
    mkdirSync(path.join(backupDir, dir));
    survivors.push(link, dir);
    return { oldFile, survivors, outside };
  }

  it("dry run counts the one old regular file and deletes nothing", () => {
    const { oldFile, survivors } = seedDir();
    const out = pruneRetentionBackups(backupDir, NOW, false);
    expect(out).toEqual({ candidates: 1, deleted: 0 });
    expect(existsSync(path.join(backupDir, oldFile))).toBe(true);
    for (const f of survivors) expect(lstatSync(path.join(backupDir, f))).toBeTruthy();
  });

  it("apply deletes only the old regular matching file", () => {
    const { oldFile, survivors, outside } = seedDir();
    const out = pruneRetentionBackups(backupDir, NOW, true);
    expect(out).toEqual({ candidates: 1, deleted: 1 });
    expect(existsSync(path.join(backupDir, oldFile))).toBe(false);
    for (const f of survivors) expect(lstatSync(path.join(backupDir, f))).toBeTruthy();
    expect(existsSync(outside)).toBe(true);
  });

  it("a missing directory is a no-op with no error", () => {
    expect(pruneRetentionBackups(path.join(tmpBase, "nope"), NOW, true)).toEqual({ candidates: 0, deleted: 0 });
  });

  it("never treats an invalid-date name as a candidate", () => {
    mkdirSync(backupDir, { recursive: true });
    const bad = "retention-2026-13-01T00-00-00-000Z.jsonl";
    writeFileSync(path.join(backupDir, bad), "keep\n");
    expect(pruneRetentionBackups(backupDir, NOW, true)).toEqual({ candidates: 0, deleted: 0 });
    expect(existsSync(path.join(backupDir, bad))).toBe(true);
  });

  it("refuses a backup dir that is a symlink: deletes nothing, reports an error, run is not ok", async () => {
    const real = path.join(tmpBase, "real-dir");
    mkdirSync(real);
    const oldFile = path.join(real, nameAt(daysBefore(31)));
    writeFileSync(oldFile, "keep\n");
    symlinkSync(real, backupDir);

    const out = pruneRetentionBackups(backupDir, NOW, true);
    expect(out.deleted).toBe(0);
    expect(out.error).toMatch(/symlink or not a directory/);
    expect(existsSync(oldFile)).toBe(true);

    const summary = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(summary.ok).toBe(false);
    expect(existsSync(oldFile)).toBe(true);
  });

  it("runRetentionPrune apply removes the old backup and reports it; dry run leaves it", async () => {
    const { oldFile } = seedDir();
    const dry = await runRetentionPrune({ apply: false, now: NOW, backupDir });
    expect(dry.backups).toEqual({ candidates: 1, deleted: 0 });
    expect(existsSync(path.join(backupDir, oldFile))).toBe(true);

    const applied = await runRetentionPrune({ apply: true, now: NOW, backupDir });
    expect(applied.backups).toEqual({ candidates: 1, deleted: 1 });
    expect(applied.ok).toBe(true);
    expect(existsSync(path.join(backupDir, oldFile))).toBe(false);
  });
});
