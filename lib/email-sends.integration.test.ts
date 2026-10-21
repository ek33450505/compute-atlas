// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { emailSendsTable, stateDigestRunsTable, subscriptionsTable } from "@/lib/db/schema";
import {
  CONFIRM_CAP_MAX,
  CONFIRM_CAP_WINDOW_MS,
  completeSend,
  countRecentConfirmSends,
  recordSendAttempt,
  recordSkip,
  type EmailSendBase,
  type EmailSendsDb,
} from "@/lib/email-sends";
import { normalizeEmail } from "@/lib/email-address";
import { hashNotifyEmail } from "@/lib/rate-limit";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;
let db: EmailSendsDb;

const EMAIL = "Reader.Person@example.com";
/** The stored hash is over the NORMALISED address. */
const hashOf = (email: string) => hashNotifyEmail(normalizeEmail(email));
const base: EmailSendBase = { kind: "confirm", email: EMAIL };

const MIGRATION = readFileSync(join(process.cwd(), "drizzle/0017_email_send_ledger.sql"), "utf-8");
const statements = MIGRATION.split("--> statement-breakpoint").map((s) => s.trim());

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "test-salt-for-email-sends";
  tdb = await makeTestDb();
  db = tdb.db;
});

beforeEach(async () => {
  await tdb.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tdb.client.close();
});

async function only() {
  const rows = await tdb.db.select().from(emailSendsTable);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("migration 0017", () => {
  it("applies cleanly a second time (idempotent) and keeps both FKs single", async () => {
    for (const stmt of statements) await tdb.client.exec(stmt);
    for (const stmt of statements) await tdb.client.exec(stmt);
    const fks = await tdb.client.query<{ conname: string }>(
      "select conname from pg_constraint where conrelid = 'email_sends'::regclass and contype = 'f'"
    );
    expect(fks.rows.map((r) => r.conname).sort()).toEqual([
      "email_sends_run_id_state_digest_runs_id_fk",
      "email_sends_subscription_id_subscriptions_id_fk",
    ]);
  });
});

describe("recordSendAttempt / completeSend", () => {
  it("inserts an attempted row with a hashed address and no completion", async () => {
    const id = await recordSendAttempt(db, { ...base, targetType: "facility", targetId: "alpha" });
    const row = await only();
    expect(row).toMatchObject({
      id,
      kind: "confirm",
      emailHash: hashOf(EMAIL),
      targetType: "facility",
      targetId: "alpha",
      outcome: "attempted",
      completedAt: null,
      resendId: null,
      errorCode: null,
    });
  });

  it("never stores the plaintext address in any column", async () => {
    const id = await recordSendAttempt(db, base);
    await completeSend(db, id, { sent: true, resendId: "re_1" });
    const row = await only();
    for (const value of Object.values(row)) {
      const text = String(value instanceof Date ? value.toISOString() : value).toLowerCase();
      expect(text).not.toContain("reader.person");
      expect(text).not.toContain("example.com");
    }
  });

  it("sent -> outcome sent + resend_id + completed_at", async () => {
    const id = await recordSendAttempt(db, base);
    await completeSend(db, id, { sent: true, resendId: "re_abc" });
    const row = await only();
    expect(row).toMatchObject({ outcome: "sent", resendId: "re_abc", errorCode: null });
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it("error -> outcome error + error_code", async () => {
    const id = await recordSendAttempt(db, base);
    await completeSend(db, id, { sent: false, errorCode: "validation_error" });
    expect(await only()).toMatchObject({ outcome: "error", errorCode: "validation_error", resendId: null });
  });

  it("no_key -> skipped_no_key", async () => {
    const id = await recordSendAttempt(db, base);
    await completeSend(db, id, { sent: false, errorCode: "no_key", skipped: "no_key" });
    const row = await only();
    expect(row).toMatchObject({ outcome: "skipped_no_key", errorCode: null });
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it('re-sanitises a crafted errorCode to "unknown"', async () => {
    const id = await recordSendAttempt(db, base);
    await completeSend(db, id, { sent: false, errorCode: "a b@c" });
    expect(await only()).toMatchObject({ outcome: "error", errorCode: "unknown" });
  });

  it('bare { sent: false } -> error with code "refused"', async () => {
    const id = await recordSendAttempt(db, base);
    await completeSend(db, id, { sent: false });
    expect(await only()).toMatchObject({ outcome: "error", errorCode: "refused" });
  });

  it("swallows a DB failure and logs only a SQLSTATE-shaped code", async () => {
    const id = await recordSendAttempt(db, base);
    const secret = "reader.person@example.com";
    const err = Object.assign(new Error(`Failed query: update ... params: ${secret}`), { code: "08006" });
    vi.spyOn(db, "update").mockImplementation(() => {
      throw err;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(completeSend(db, id, { sent: true, resendId: "re_x" })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("08006");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("Failed query");
    vi.restoreAllMocks();
    expect((await only()).outcome).toBe("attempted");
  });

  it("recordSendAttempt throws on a DB error", async () => {
    vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(recordSendAttempt(db, base)).rejects.toThrow("boom");
  });
});

describe("recordSkip", () => {
  it("inserts a completed skip row", async () => {
    await recordSkip(db, { ...base, kind: "facility_change" }, "skipped_suppressed");
    const row = await only();
    expect(row).toMatchObject({ kind: "facility_change", outcome: "skipped_suppressed", emailHash: hashOf(EMAIL) });
    expect(row.completedAt).toBeInstanceOf(Date);
  });
});

describe("countRecentConfirmSends", () => {
  const NOW = new Date("2026-10-21T12:00:00Z");
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
  const seed = (over: Partial<typeof emailSendsTable.$inferInsert>) =>
    tdb.db.insert(emailSendsTable).values({ kind: "confirm", emailHash: hashOf(EMAIL), ...over });

  it("exports the agreed cap", () => {
    expect(CONFIRM_CAP_MAX).toBe(10);
    expect(CONFIRM_CAP_WINDOW_MS).toBe(30 * 86_400_000);
  });

  it("counts inside the window, excludes rows just outside it", async () => {
    await seed({ createdAt: daysAgo(29.9) });
    await seed({ createdAt: daysAgo(30.1) });
    expect(await countRecentConfirmSends(db, EMAIL, CONFIRM_CAP_WINDOW_MS, NOW)).toBe(1);
    expect(await countRecentConfirmSends(db, EMAIL, 60 * 86_400_000, NOW)).toBe(2);
  });

  it("counts attempted, sent and error; ignores every skipped_* outcome", async () => {
    for (const outcome of ["attempted", "sent", "error"]) await seed({ outcome });
    for (const outcome of ["skipped_no_key", "skipped_suppressed", "skipped_unconfirmed", "skipped_capped"])
      await seed({ outcome });
    // skipped_no_key mailed nothing either, so it is excluded too.
    expect(await countRecentConfirmSends(db, EMAIL)).toBe(3);
  });

  it("counts mixed-case and padded variants of one address together, under one hash", async () => {
    await recordSendAttempt(db, { kind: "confirm", email: "Foo@X.com" });
    await recordSendAttempt(db, { kind: "confirm", email: "  foo@x.COM " });
    await recordSkip(db, { kind: "confirm", email: "FOO@x.com" }, "skipped_capped");
    const rows = await tdb.db.select().from(emailSendsTable);
    expect(new Set(rows.map((r) => r.emailHash)).size).toBe(1);
    expect(rows[0].emailHash).toBe(hashNotifyEmail("foo@x.com"));
    expect(await countRecentConfirmSends(db, " fOO@X.com")).toBe(2);
  });

  it("ignores other kinds and other addresses", async () => {
    await seed({ kind: "watch_started" });
    await seed({ kind: "state_digest" });
    await seed({ emailHash: hashOf("someone.else@example.com") });
    await seed({});
    expect(await countRecentConfirmSends(db, EMAIL)).toBe(1);
  });
});

describe("foreign keys", () => {
  it("deleting the subscription or the digest run nulls the reference and keeps the row", async () => {
    const [sub] = await tdb.db
      .insert(subscriptionsTable)
      .values({
        email: "reader.person@example.com",
        targetType: "facility",
        targetId: "alpha",
        status: "confirmed",
        confirmToken: "c-1",
        unsubscribeToken: "u-1",
      })
      .returning({ id: subscriptionsTable.id });
    const [run] = await tdb.db
      .insert(stateDigestRunsTable)
      .values({ since: new Date(0), until: new Date(1000) })
      .returning({ id: stateDigestRunsTable.id });
    const id = await recordSendAttempt(db, { ...base, kind: "state_digest", subscriptionId: sub.id, runId: run.id });
    expect(await only()).toMatchObject({ subscriptionId: sub.id, runId: run.id });

    await tdb.db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, sub.id));
    await tdb.db.delete(stateDigestRunsTable).where(eq(stateDigestRunsTable.id, run.id));

    expect(await only()).toMatchObject({ id, subscriptionId: null, runId: null });
  });
});
