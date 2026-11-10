// @vitest-environment node
import { eq, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client");
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendDatasetEditionNoticeEmail: vi.fn(),
  sendDatasetRenewalReminderEmail: vi.fn(),
}));

import * as dbClient from "@/lib/db/client";
import {
  DATASET_RENEWAL_REMINDER_WINDOW_MS,
  DATASET_SEND_TIMEOUT_MS,
  makePacer,
  sendEditionNotices,
  sendRenewalReminders,
} from "@/lib/dataset-notices";
import { datasetAccessGrantsTable, datasetEditionsTable, type DatasetGrantStatus } from "@/lib/db/schema";
import { sendDatasetEditionNoticeEmail, sendDatasetRenewalReminderEmail } from "@/lib/email";
import type { SendOutcome } from "@/lib/email";
import { suppress } from "@/lib/suppressions";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;

const OK: SendOutcome = { sent: true, resendId: "r-1" };
const FAIL: SendOutcome = { sent: false, errorCode: "rate_limit_exceeded" };
const DAY = 24 * 60 * 60 * 1000;
const noticeMock = vi.mocked(sendDatasetEditionNoticeEmail);
const reminderMock = vi.mocked(sendDatasetRenewalReminderEmail);

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "dataset-notices-test-salt";
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  noticeMock.mockReset().mockResolvedValue(OK);
  reminderMock.mockReset().mockResolvedValue(OK);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tdb.client.close();
});

let seq = 0;
type SeedGrant = {
  email?: string;
  status?: DatasetGrantStatus;
  expiresAt?: Date | null;
  unsubscribeToken?: string | null;
  renewalRemindedAt?: Date | null;
  renewalRequestedAt?: Date | null;
  renewTokenHash?: string | null;
  tier?: "free" | "commercial";
  paidThrough?: Date | null;
};

/** A live grant by default (active, expires in 100 days). Ids are random uuids, so order is set by the query, not the insert. */
async function seedGrant(over: SeedGrant = {}) {
  seq++;
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: over.email ?? `reader${seq}@example.com`,
      name: "Reader",
      category: "journalist",
      intendedUse: "testing",
      attributionAckAt: new Date(),
      termsVersion: "t",
      status: over.status ?? "active",
      verifyTokenHash: `v${seq}`.padEnd(64, "0"),
      accessTokenHash: `a${seq}`.padEnd(64, "0"),
      unsubscribeToken: over.unsubscribeToken === undefined ? `unsub-${seq}`.padEnd(43, "x") : over.unsubscribeToken,
      expiresAt: over.expiresAt === undefined ? new Date(Date.now() + 100 * DAY) : over.expiresAt,
      renewalRemindedAt: over.renewalRemindedAt ?? null,
      renewalRequestedAt: over.renewalRequestedAt ?? null,
      renewTokenHash: over.renewTokenHash ?? null,
      tier: over.tier ?? "free",
      paidThrough: over.paidThrough ?? null,
    })
    .returning();
  return row;
}

async function seedEdition(editionDate: string, over: { status?: "published" | "building"; summary?: unknown } = {}) {
  const [row] = await tdb.db
    .insert(datasetEditionsTable)
    .values({
      editionDate,
      status: over.status ?? "published",
      recordCount: 2300,
      changelogSummary: over.summary ?? { added: 3, updated: 4, removed: 1, headlines: ["Zeta Campus is now operational"] },
    })
    .returning();
  return row;
}

const grantRow = async (id: string) =>
  (await tdb.db.select().from(datasetAccessGrantsTable).where(eq(datasetAccessGrantsTable.id, id)))[0];
const editionRow = async (id: string) =>
  (await tdb.db.select().from(datasetEditionsTable).where(eq(datasetEditionsTable.id, id)))[0];
const noticeRecipients = () => noticeMock.mock.calls.map(([input]) => input.email).sort();

describe("sendEditionNotices", () => {
  it("mails each live grant once with the edition fields, claims it, and marks the edition", async () => {
    await seedEdition("2026-11-02");
    const e2 = await seedEdition("2026-11-09");
    const a = await seedGrant();
    const b = await seedGrant();

    const res = await sendEditionNotices(e2.id, { paceMs: 0 });

    expect(res).toEqual({ claimed: 2, sent: 2, skipped: 0, failed: 0, complete: true });
    expect(noticeRecipients()).toEqual([a.email, b.email].sort());
    expect(noticeMock).toHaveBeenCalledWith({
      email: a.email,
      editionDate: "2026-11-09",
      unsubscribeToken: a.unsubscribeToken,
      recordCount: 2300,
      summary: { added: 3, updated: 4, removed: 1, headlines: ["Zeta Campus is now operational"] },
    });
    expect((await grantRow(a.id)).lastNoticeEditionId).toBe(e2.id);
    expect((await editionRow(e2.id)).noticeSentAt).toBeInstanceOf(Date);
  });

  it("the initial edition carries no change summary", async () => {
    const e1 = await seedEdition("2026-11-09", { summary: { added: 0, updated: 0, removed: 0, headlines: ["Initial edition: 2300 records"] } });
    await seedGrant();
    await sendEditionNotices(e1.id, { paceMs: 0 });
    expect(noticeMock.mock.calls[0][0].summary).toBeUndefined();
    expect(noticeMock.mock.calls[0][0].recordCount).toBe(2300);
  });

  it("a malformed stored summary is dropped rather than mailed", async () => {
    await seedEdition("2026-11-02");
    const e2 = await seedEdition("2026-11-09", { summary: { added: "3", headlines: [{ x: 1 }] } });
    await seedGrant();
    await sendEditionNotices(e2.id, { paceMs: 0 });
    expect(noticeMock.mock.calls[0][0].summary).toBeUndefined();
    // Dropping the counts line is visible: one fixed-code warning per run, however many grantees.
    const warned = vi.mocked(console.warn).mock.calls.flat().filter((m) => String(m).includes("summary malformed"));
    expect(warned).toEqual(["dataset notices: changelog summary malformed, counts line omitted (code: summary_malformed)"]);
  });

  it("mails nobody who is not live: pending, revoked, expired, lapsed", async () => {
    const e = await seedEdition("2026-11-09");
    const live = await seedGrant();
    await seedGrant({ status: "pending_review" });
    await seedGrant({ status: "revoked" });
    await seedGrant({ status: "expired", expiresAt: new Date(Date.now() - DAY) });
    await seedGrant({ expiresAt: new Date(Date.now() - DAY) });

    const res = await sendEditionNotices(e.id, { paceMs: 0 });

    expect(res).toMatchObject({ sent: 1, complete: true });
    expect(noticeRecipients()).toEqual([live.email]);
  });

  it("sends nothing to a grant that opted out, globally or from the weekly notice, but still claims it", async () => {
    const e = await seedEdition("2026-11-09");
    const globalOut = await seedGrant();
    const targetOut = await seedGrant();
    const normal = await seedGrant();
    await suppress(tdb.db, globalOut.email, { kind: "global" }, "unsubscribe");
    await suppress(tdb.db, targetOut.email, { kind: "target", targetType: "dataset_edition", targetId: "weekly" }, "unsubscribe");

    const res = await sendEditionNotices(e.id, { paceMs: 0 });

    expect(res).toMatchObject({ sent: 1, skipped: 2, failed: 0, complete: true });
    expect(noticeRecipients()).toEqual([normal.email]);
    expect((await grantRow(globalOut.id)).lastNoticeEditionId).toBe(e.id);
  });

  it("does not mail a grant without an unsubscribe token (no opt-out link to put in the mail)", async () => {
    const e = await seedEdition("2026-11-09");
    const noToken = await seedGrant({ unsubscribeToken: null });
    const res = await sendEditionNotices(e.id, { paceMs: 0 });
    expect(res).toMatchObject({ sent: 0, skipped: 1, complete: true });
    expect(noticeMock).not.toHaveBeenCalled();
    expect((await grantRow(noToken.id)).lastNoticeEditionId).toBeNull();
  });

  it("a failed send is not retried: the claim persists and a rerun mails nobody again", async () => {
    const e = await seedEdition("2026-11-09");
    await seedGrant();
    noticeMock.mockResolvedValue(FAIL);

    expect(await sendEditionNotices(e.id, { paceMs: 0 })).toMatchObject({ sent: 0, failed: 1, complete: true });
    noticeMock.mockResolvedValue(OK);
    expect(await sendEditionNotices(e.id, { paceMs: 0 })).toMatchObject({ claimed: 0, sent: 0, complete: true });
    expect(noticeMock).toHaveBeenCalledTimes(1);
  });

  it("a commercial grant whose paid_through lapses after the candidate read is not claimed or mailed", async () => {
    const e = await seedEdition("2026-11-09");
    await seedGrant({ tier: "commercial", paidThrough: new Date(Date.now() + 10 * DAY) });
    await seedGrant({ tier: "commercial", paidThrough: new Date(Date.now() + 10 * DAY) });
    // Both are candidates at read time. While the first is being mailed, the other one's payment lapses.
    noticeMock.mockImplementation(async ({ email }) => {
      await tdb.db
        .update(datasetAccessGrantsTable)
        .set({ paidThrough: new Date(Date.now() - DAY) })
        .where(ne(datasetAccessGrantsTable.email, email));
      return OK;
    });

    const res = await sendEditionNotices(e.id, { paceMs: 0 });

    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ claimed: 1, sent: 1, skipped: 1 });
  });

  it("two overlapping runs mail each grant once (claim BEFORE send)", async () => {
    const e = await seedEdition("2026-11-09");
    await seedGrant();
    await seedGrant();
    await seedGrant();
    // Each send yields, so a run that sent before claiming would let the other run send too.
    noticeMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return OK;
    });

    await Promise.all([sendEditionNotices(e.id, { paceMs: 0 }), sendEditionNotices(e.id, { paceMs: 0 })]);

    expect(noticeMock).toHaveBeenCalledTimes(3);
    expect(new Set(noticeRecipients()).size).toBe(3);
  });

  it("claim E1, publish E2, claim E2, re-run E1: no row is claimed and no mail goes out", async () => {
    const e1 = await seedEdition("2026-11-02");
    const g = await seedGrant();
    await sendEditionNotices(e1.id, { paceMs: 0 });
    expect((await grantRow(g.id)).lastNoticeEditionId).toBe(e1.id);

    const e2 = await seedEdition("2026-11-09");
    await sendEditionNotices(e2.id, { paceMs: 0 });
    expect((await grantRow(g.id)).lastNoticeEditionId).toBe(e2.id);
    expect(noticeMock).toHaveBeenCalledTimes(2);

    noticeMock.mockClear();
    const rerun = await sendEditionNotices(e1.id, { paceMs: 0 });

    expect(rerun).toMatchObject({ claimed: 0, sent: 0, skipped: 1 });
    expect(noticeMock).not.toHaveBeenCalled();
    expect((await grantRow(g.id)).lastNoticeEditionId).toBe(e2.id);
  });

  it("does not mark a superseded edition as noticed", async () => {
    const e1 = await seedEdition("2026-11-02");
    await seedEdition("2026-11-09");
    await seedGrant();
    await sendEditionNotices(e1.id, { paceMs: 0 });
    expect((await editionRow(e1.id)).noticeSentAt).toBeNull();
  });

  it("a grant revoked or expired between selection and claim is not mailed", async () => {
    const e = await seedEdition("2026-11-09");
    const grants = [await seedGrant(), await seedGrant(), await seedGrant()];
    // The first send (whichever grant runs first) revokes one still-unclaimed grant and expires another.
    noticeMock.mockImplementationOnce(async ({ email }) => {
      const rest = grants.filter((g) => g.email !== email);
      await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" }).where(eq(datasetAccessGrantsTable.id, rest[0].id));
      await tdb.db
        .update(datasetAccessGrantsTable)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(datasetAccessGrantsTable.id, rest[1].id));
      return OK;
    });

    const res = await sendEditionNotices(e.id, { paceMs: 0 });

    expect(res).toMatchObject({ claimed: 1, sent: 1, skipped: 2, complete: true });
    expect(noticeMock).toHaveBeenCalledTimes(1);
  });

  describe("a hung send", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is cut off after DATASET_SEND_TIMEOUT_MS as send_timeout: counted failed, claim kept (at-most-once), next grant proceeds", async () => {
      const e = await seedEdition("2026-11-09");
      const a = await seedGrant();
      const b = await seedGrant();
      noticeMock.mockReset().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(OK);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = sendEditionNotices(e.id, { paceMs: 0 });
      await vi.advanceTimersByTimeAsync(DATASET_SEND_TIMEOUT_MS + 1);
      const res = await run;
      vi.useRealTimers();

      expect(res).toEqual({ claimed: 2, sent: 1, skipped: 0, failed: 1, complete: true });
      expect(noticeMock).toHaveBeenCalledTimes(2);
      expect((await grantRow(a.id)).lastNoticeEditionId).toBe(e.id);
      expect((await grantRow(b.id)).lastNoticeEditionId).toBe(e.id);
    });

    it("clears its timer once the send settles", async () => {
      const e = await seedEdition("2026-11-09");
      await seedGrant();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = sendEditionNotices(e.id, { paceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);
      await run;
      const pending = vi.getTimerCount();
      vi.useRealTimers();
      expect(pending).toBe(0);
    });
  });

  describe("pacing and the soft deadline", () => {
    it("a pacer passed in options is shared across passes: the first send of the second pass waits", async () => {
      const e = await seedEdition("2026-11-09");
      await seedGrant();
      await seedGrant({ expiresAt: new Date(Date.now() + 10 * DAY) });
      const sleep = vi.fn(async () => {});
      const pacer = makePacer(600, sleep);

      await sendRenewalReminders({ pacer });
      expect(sleep).not.toHaveBeenCalled();
      await sendEditionNotices(e.id, { pacer });

      // One reminder went first (no wait), then two notices: a wait before each, none skipped by a fresh pacer.
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(600);
    });

    it("waits paceMs between sends that reach Resend, never before the first, and not for suppressed grants", async () => {
      const e = await seedEdition("2026-11-09");
      const suppressed = await seedGrant();
      await seedGrant();
      await seedGrant();
      await suppress(tdb.db, suppressed.email, { kind: "global" }, "unsubscribe");
      const sleep = vi.fn(async () => {});

      const res = await sendEditionNotices(e.id, { paceMs: 600, sleep });

      expect(res).toMatchObject({ sent: 2, skipped: 1 });
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(600);
    });

    it("stops cleanly at the deadline (complete false, edition unmarked) and a rerun finishes the rest", async () => {
      const e = await seedEdition("2026-11-09");
      await seedGrant();
      await seedGrant();
      await seedGrant();
      await seedGrant();
      // A fake clock: only the sleeps advance it, so the cut is exact.
      let clock = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const sleep = vi.fn(async (ms: number) => {
        clock += ms;
      });

      // Each send after the first waits 600 ms first: sends start at t=0, 600, 1200, and the check before
      // the 4th (t=1200) trips a 1100 ms budget.
      const cut = await sendEditionNotices(e.id, { paceMs: 600, deadlineMs: 1100, sleep });

      expect(cut).toMatchObject({ claimed: 3, sent: 3, complete: false });
      expect((await editionRow(e.id)).noticeSentAt).toBeNull();

      const rest = await sendEditionNotices(e.id, { paceMs: 600, deadlineMs: 1100, sleep });

      expect(rest).toMatchObject({ claimed: 1, sent: 1, complete: true });
      expect(noticeMock).toHaveBeenCalledTimes(4);
      expect(new Set(noticeRecipients()).size).toBe(4);
      expect((await editionRow(e.id)).noticeSentAt).toBeInstanceOf(Date);
    });
  });

  describe("never throws", () => {
    it("returns complete:false for a draft edition and sends nothing", async () => {
      const draft = await seedEdition("2026-11-09", { status: "building" });
      await seedGrant();
      expect(await sendEditionNotices(draft.id, { paceMs: 0 })).toMatchObject({ sent: 0, complete: false });
      expect(noticeMock).not.toHaveBeenCalled();
    });

    it("refuses an edition whose stored date is malformed", async () => {
      const bad = await seedEdition("2026-11-9<b>");
      await seedGrant();
      expect(await sendEditionNotices(bad.id, { paceMs: 0 })).toMatchObject({ sent: 0, complete: false });
      expect(noticeMock).not.toHaveBeenCalled();
    });

    it("catches a database failure and logs a code only", async () => {
      vi.mocked(dbClient.getDb).mockImplementationOnce(() => {
        throw Object.assign(new Error("connect to secret-host failed for reader@example.com"), { code: "ECONNREFUSED" });
      });
      const res = await sendEditionNotices("00000000-0000-4000-8000-000000000000", { paceMs: 0 });
      expect(res.complete).toBe(false);
      const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
      expect(logged).toContain("ECONNREFUSED");
      expect(logged).not.toContain("secret-host");
      expect(logged).not.toContain("reader@example.com");
    });

    it("logs counts and no address or token on a normal run", async () => {
      const e = await seedEdition("2026-11-09");
      const g = await seedGrant();
      await sendEditionNotices(e.id, { paceMs: 0 });
      const logged = [console.info, console.warn, console.error].flatMap((fn) => vi.mocked(fn).mock.calls.flat()).join(" ");
      expect(logged).not.toContain(g.email);
      expect(logged).not.toContain(g.unsubscribeToken!);
    });
  });
});

describe("sendRenewalReminders", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const soon = () => new Date(Date.now() + 10 * DAY);

  it("reminds a grant inside the 30-day window once: stamps renewalRemindedAt, mints a renew token, never repeats", async () => {
    const g = await seedGrant({ expiresAt: soon() });

    const res = await sendRenewalReminders({ paceMs: 0 });

    expect(res).toMatchObject({ sent: 1, failed: 0, complete: true });
    expect(reminderMock).toHaveBeenCalledTimes(1);
    const input = reminderMock.mock.calls[0][0];
    expect(input.email).toBe(g.email);
    expect(input.renewToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(input.expiresAt.getTime()).toBe(g.expiresAt!.getTime());
    const after = await grantRow(g.id);
    expect(after.renewalRemindedAt).toBeInstanceOf(Date);
    expect(after.renewTokenHash).not.toBeNull();

    await sendRenewalReminders({ paceMs: 0 });
    expect(reminderMock).toHaveBeenCalledTimes(1);
  });

  it("a failed send leaves renewalRemindedAt null so the next run retries", async () => {
    const g = await seedGrant({ expiresAt: soon() });
    reminderMock.mockResolvedValueOnce(FAIL);

    expect(await sendRenewalReminders({ paceMs: 0 })).toMatchObject({ sent: 0, failed: 1 });
    expect((await grantRow(g.id)).renewalRemindedAt).toBeNull();

    expect(await sendRenewalReminders({ paceMs: 0 })).toMatchObject({ sent: 1, failed: 0 });
    expect(reminderMock).toHaveBeenCalledTimes(2);
    expect((await grantRow(g.id)).renewalRemindedAt).toBeInstanceOf(Date);
  });

  it("two overlapping passes remind each grant once (claim BEFORE send; no token rotated under a sent mail)", async () => {
    await seedGrant({ expiresAt: soon() });
    await seedGrant({ expiresAt: soon() });
    await seedGrant({ expiresAt: soon() });
    reminderMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return OK;
    });

    await Promise.all([sendRenewalReminders({ paceMs: 0 }), sendRenewalReminders({ paceMs: 0 })]);

    expect(reminderMock).toHaveBeenCalledTimes(3);
    expect(new Set(reminderMock.mock.calls.map(([i]) => i.email)).size).toBe(3);
    expect(new Set(reminderMock.mock.calls.map(([i]) => i.renewToken)).size).toBe(3);
  });

  it("a suppressed grant's renew token is not rotated by the pass (the token is minted only once the gate allows a send)", async () => {
    const original = "r".padEnd(64, "0");
    const g = await seedGrant({ expiresAt: soon(), renewTokenHash: original });
    await suppress(tdb.db, g.email, { kind: "global" }, "unsubscribe");

    await sendRenewalReminders({ paceMs: 0 });
    await sendRenewalReminders({ paceMs: 0 });

    expect((await grantRow(g.id)).renewTokenHash).toBe(original);
    expect((await grantRow(g.id)).renewalRemindedAt).toBeNull();
  });

  it("a grant that stops being live between the gate and the token mint is not mailed and its claim is released", async () => {
    const a = await seedGrant({ expiresAt: soon() });
    const b = await seedGrant({ expiresAt: soon() });
    // The second send's pacing wait runs inside the gate callback, after the gate said yes: revoke everything then.
    const sleep = vi.fn(async () => {
      await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    });

    const res = await sendRenewalReminders({ paceMs: 600, sleep });

    expect(res).toMatchObject({ sent: 1, failed: 1, complete: true });
    expect(reminderMock).toHaveBeenCalledTimes(1);
    const rows = [await grantRow(a.id), await grantRow(b.id)];
    expect(rows.filter((r) => r.renewalRemindedAt !== null)).toHaveLength(1);
  });

  it("a hung send is cut off as send_timeout and the claim is released so the next run retries", async () => {
    const g = await seedGrant({ expiresAt: soon() });
    reminderMock.mockReset().mockImplementationOnce(() => new Promise(() => {}));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = sendRenewalReminders({ paceMs: 0 });
    await vi.advanceTimersByTimeAsync(DATASET_SEND_TIMEOUT_MS + 1);
    const res = await run;
    vi.useRealTimers();

    expect(res).toMatchObject({ sent: 0, failed: 1, complete: true });
    expect((await grantRow(g.id)).renewalRemindedAt).toBeNull();

    reminderMock.mockResolvedValue(OK);
    expect(await sendRenewalReminders({ paceMs: 0 })).toMatchObject({ sent: 1 });
  });

  it("a claim release that fails is contained: logged as a code, the pass carries on with the next grant", async () => {
    await seedGrant({ expiresAt: soon() });
    await seedGrant({ expiresAt: soon() });
    reminderMock.mockResolvedValue(FAIL);
    const realUpdate = tdb.db.update.bind(tdb.db);
    vi.spyOn(tdb.db, "update").mockImplementation(((table: never) => {
      const builder = realUpdate(table) as unknown as { set: (v: Record<string, unknown>) => unknown };
      const realSet = builder.set.bind(builder);
      builder.set = (values) => {
        if ("renewalRemindedAt" in values && values.renewalRemindedAt === null) {
          throw Object.assign(new Error("release failed for reader@example.com"), { code: "57P01" });
        }
        return realSet(values);
      };
      return builder;
    }) as never);

    const res = await sendRenewalReminders({ paceMs: 0 });

    expect(res).toMatchObject({ sent: 0, failed: 2, complete: true });
    expect(reminderMock).toHaveBeenCalledTimes(2);
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("57P01");
    expect(logged).not.toContain("reader@example.com");
  });

  it("skips a grant outside the window, already reminded, renewal-pending, lapsed or not active", async () => {
    await seedGrant({ expiresAt: new Date(Date.now() + DATASET_RENEWAL_REMINDER_WINDOW_MS + DAY) });
    await seedGrant({ expiresAt: soon(), renewalRemindedAt: new Date() });
    await seedGrant({ expiresAt: soon(), renewalRequestedAt: new Date() });
    await seedGrant({ expiresAt: new Date(Date.now() - DAY) });
    await seedGrant({ expiresAt: soon(), status: "revoked" });
    await seedGrant({ expiresAt: soon(), status: "pending_review" });

    const res = await sendRenewalReminders({ paceMs: 0 });

    expect(res).toEqual({ claimed: 0, sent: 0, skipped: 0, failed: 0, complete: true });
    expect(reminderMock).not.toHaveBeenCalled();
  });

  it("a suppressed grant gets no reminder and is not stamped", async () => {
    const g = await seedGrant({ expiresAt: soon() });
    await suppress(tdb.db, g.email, { kind: "global" }, "unsubscribe");

    const res = await sendRenewalReminders({ paceMs: 0 });

    expect(res).toMatchObject({ sent: 0, skipped: 1, complete: true });
    expect(reminderMock).not.toHaveBeenCalled();
    expect((await grantRow(g.id)).renewalRemindedAt).toBeNull();
  });

  it("paces sends and stops at the deadline, then a rerun reminds the rest", async () => {
    await seedGrant({ expiresAt: soon() });
    await seedGrant({ expiresAt: soon() });
    await seedGrant({ expiresAt: soon() });
    let clock = 5_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const cut = await sendRenewalReminders({ paceMs: 600, deadlineMs: 500, sleep });

    expect(cut).toMatchObject({ sent: 2, complete: false });
    expect(sleep).toHaveBeenCalledWith(600);
    const rest = await sendRenewalReminders({ paceMs: 600, deadlineMs: 500, sleep });
    expect(rest).toMatchObject({ sent: 1, complete: true });
    expect(reminderMock).toHaveBeenCalledTimes(3);
  });

  it("never throws: a database failure is logged as a code", async () => {
    vi.mocked(dbClient.getDb).mockImplementationOnce(() => {
      throw Object.assign(new Error("boom reader@example.com"), { code: "ECONNREFUSED" });
    });
    const res = await sendRenewalReminders({ paceMs: 0 });
    expect(res.complete).toBe(false);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("reader@example.com");
  });
});
