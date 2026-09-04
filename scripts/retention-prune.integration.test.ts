// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("../lib/db/client");

import * as dbClient from "../lib/db/client";
import { makeTestDb, type TestDbHandle } from "../test/pglite-db";
import {
  apiAccessGrantsTable,
  apiDailyUsageTable,
  contactMessagesTable,
  leadsTable,
  submissionsTable,
  subscriptionsTable,
} from "../lib/db/schema";
import { runRetentionPrune } from "./retention-prune";

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
    expect(byTable.api_access_grants.candidates).toBe(2); // old-revoked + old-expired
    expect(byTable.api_daily_usage.candidates).toBe(1);
    for (const t of summary.tables) {
      expect(t.applied).toBe(0);
    }

    // Nothing written: no backup dir/files, no rows removed, no provenance stripped.
    expect(() => readdirSync(backupDir)).toThrow();
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
    expect(lines).toHaveLength(8); // 1+2+1+1+2+1 == sum of `applied` above
    const byId = Object.fromEntries(lines.map((l) => [l.row.id, l]));
    expect(byId[ids.contactOld]).toMatchObject({ table: "contact_messages", action: "delete" });
    expect(byId[ids.leadOldPromoted]).toMatchObject({ table: "leads", action: "delete" });
    expect(byId[ids.leadOldDismissedNoReview]).toMatchObject({ table: "leads", action: "delete" });
    expect(byId[ids.subOldReviewed]).toMatchObject({ table: "submissions", action: "strip-ip-hash" });
    expect(byId[ids.subscriptionOldUnsub]).toMatchObject({ table: "subscriptions", action: "delete" });
    expect(byId[ids.grantOldRevoked]).toMatchObject({ table: "api_access_grants", action: "delete" });
    expect(byId[ids.grantOldExpired]).toMatchObject({ table: "api_access_grants", action: "delete" });
    expect(byId[ids.usageOld]).toMatchObject({ table: "api_daily_usage", action: "delete" });
    // Rows that must NOT appear in the backup at all (never touched).
    for (const untouchedId of [ids.contactFresh, ids.leadFreshPromoted, ids.leadOldNew, ids.subFreshReviewed, ids.subOldPending]) {
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
    const contactOutcome = summary.tables.find((t) => t.table === "contact_messages")!;
    expect(contactOutcome.candidates).toBe(1);
    expect(contactOutcome.applied).toBe(0);
    expect(contactOutcome.error).toMatch(/backup failed, mutation skipped/);

    // The row survives — the mutation was never attempted.
    const remaining = await tdb.db.select().from(contactMessagesTable);
    expect(remaining.map((r) => r.id)).toEqual([contactOld.id]);
  });
});
